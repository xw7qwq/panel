import { availableMetrics, healthMetrics, healthSeries } from './health.js';
import { ledgerBalances, ledgerMonthly, ledgerSummary, ledgerTransactions } from './ledger.js';
import { publicOj } from './oj.js';
import { UpstreamError, fetchUpstream, macStatus, ojSummary, readSnapshot, solutionPath, solutionRawUrl, solutionsIndex } from './sources.js';

// MCP 工具：全部只读。参数按 JSON Schema 声明，执行前再做一次简单校验；
// 数据暂时取不到时返回 isError 结果，让模型知道原因，而不是协议错误。
export class ToolError extends Error {}

const PLATFORMS = ['atcoder', 'codeforces', 'qoj', 'nowcoder'];
const DATE = '^\\d{4}-\\d{2}-\\d{2}$';
const MONTH = '^\\d{4}-\\d{2}$';
const READ_ONLY = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false };

function object(properties = {}, required = []) {
  return { type: 'object', properties, required, additionalProperties: false };
}

function integer(args, name, { min, max, fallback }) {
  const value = args[name];
  if (value === undefined || value === null) return fallback;
  if (!Number.isInteger(value) || value < min || value > max) throw new ToolError(`${name} 必须是 ${min} 到 ${max} 之间的整数`);
  return value;
}

function text(args, name, { max = 200, pattern = null, values = null, fallback = '' } = {}) {
  const value = args[name];
  if (value === undefined || value === null || value === '') return fallback;
  if (typeof value !== 'string' || value.length > max) throw new ToolError(`${name} 必须是不超过 ${max} 个字符的字符串`);
  if (pattern && !new RegExp(pattern).test(value)) throw new ToolError(`${name} 的格式不对`);
  if (values && !values.includes(value)) throw new ToolError(`${name} 只能是 ${values.join('、')} 之一`);
  return value;
}

async function snapshot(env, name, label) {
  const value = await readSnapshot(env, name);
  if (!value) throw new ToolError(`${label}数据还没有推送到面板`);
  return value;
}

async function oj(env) {
  try {
    return await ojSummary(env);
  } catch (error) {
    if (error instanceof UpstreamError) throw new ToolError(`刷题数据暂时取不到：${error.message}`);
    throw error;
  }
}

export const TOOLS = [
  {
    name: 'get_overview',
    title: '面板总览',
    description: '一次读取各栏目的最新概况：刷题（总题数、今天/本月、连续天数、最近通过）、Mac 当前状态、健康指标（最新值和 7/30 天均值）、本月收支。适合作为分析的第一步。',
    inputSchema: object(),
    async run(_args, env) {
      const [ojResult, nowResult, health, ledger] = await Promise.allSettled([
        ojSummary(env),
        macStatus(env),
        readSnapshot(env, 'health'),
        readSnapshot(env, 'ledger'),
      ]);
      const ojValue = ojResult.status === 'fulfilled' ? publicOj(ojResult.value) : null;
      if (ojValue) delete ojValue.daily;
      return {
        oj: ojValue,
        now: nowResult.status === 'fulfilled' ? nowResult.value : null,
        health: health.status === 'fulfilled' && health.value ? { generated_at: health.value.generated_at ?? null, metrics: healthMetrics(health.value) } : null,
        ledger: ledger.status === 'fulfilled' && ledger.value ? ledgerSummary(ledger.value) : null,
      };
    },
  },
  {
    name: 'get_oj_stats',
    title: '刷题统计',
    description: '刷题统计：各平台已通过题数、AC 次数、当前与最高 rating，连续刷题天数，今天/近 7 天/本月/今年的首次 AC 数，以及按月、按平台的首次 AC 数。日期按 UTC+8。',
    inputSchema: object({ platform: { type: 'string', enum: PLATFORMS, description: '只看一个平台' } }),
    async run(args, env) {
      const platform = text(args, 'platform', { values: PLATFORMS });
      const summary = await oj(env);
      const monthly = Object.fromEntries(
        Object.entries(summary.monthly || {}).map(([month, counts]) => [month, platform ? counts[platform] ?? 0 : counts]),
      );
      return {
        generated_at: summary.generated_at,
        today: summary.today,
        solved: platform ? summary.platforms?.[platform]?.solved ?? null : summary.solved,
        counts: platform ? null : summary.counts,
        streak: platform ? null : summary.streak,
        platforms: platform ? { [platform]: summary.platforms?.[platform] ?? null } : summary.platforms,
        monthly,
      };
    },
  },
  {
    name: 'list_recent_accepted',
    title: '最近通过的题',
    description: '最近的 AC 提交（最多 30 条），含题名、平台、题目和提交链接、通过时间，first 表示是否首次通过该题。',
    inputSchema: object({
      limit: { type: 'integer', minimum: 1, maximum: 30, default: 10 },
      platform: { type: 'string', enum: PLATFORMS },
    }),
    async run(args, env) {
      const limit = integer(args, 'limit', { min: 1, max: 30, fallback: 10 });
      const platform = text(args, 'platform', { values: PLATFORMS });
      const summary = await oj(env);
      return (summary.recent || []).filter((item) => !platform || item.platform === platform).slice(0, limit);
    },
  },
  {
    name: 'get_oj_daily',
    title: '每日刷题数',
    description: '指定日期范围内每天的首次 AC 题数（只列出有题的日子）。范围最长 400 天，默认最近 30 天。',
    inputSchema: object({
      since: { type: 'string', pattern: DATE, description: '开始日期 YYYY-MM-DD（含）' },
      until: { type: 'string', pattern: DATE, description: '结束日期 YYYY-MM-DD（含），默认今天' },
    }),
    async run(args, env) {
      const summary = await oj(env);
      const until = text(args, 'until', { pattern: DATE, fallback: summary.today });
      const since = text(args, 'since', { pattern: DATE, fallback: shift(until, -29) });
      if (since > until) throw new ToolError('since 不能晚于 until');
      if (since < shift(until, -399)) throw new ToolError('范围最长 400 天');
      const days = Object.entries(summary.daily || {}).filter(([day]) => day >= since && day <= until);
      return { since, until, total: days.reduce((sum, [, count]) => sum + count, 0), days: Object.fromEntries(days) };
    },
  },
  {
    name: 'search_solutions',
    title: '搜索题解',
    description: '在题解仓库里按题名或路径搜索源码文件（大小写不敏感，空格分隔的词都要命中）。返回路径，可再用 get_solution_source 读取源码。',
    inputSchema: object(
      {
        query: { type: 'string', minLength: 1, maxLength: 100, description: '题名、题号或路径里的词，例如 "abc300 D" 或 "segment tree"' },
        platform: { type: 'string', maxLength: 40, description: '题解目录名，例如 AtCoder、Codeforces、Luogu' },
        limit: { type: 'integer', minimum: 1, maximum: 50, default: 20 },
      },
      ['query'],
    ),
    async run(args, env, ctx) {
      const query = text(args, 'query', { max: 100 });
      if (!query) throw new ToolError('query 不能为空');
      const platform = text(args, 'platform', { max: 40 }).toLowerCase();
      const limit = integer(args, 'limit', { min: 1, max: 50, fallback: 20 });
      const words = query.toLowerCase().split(/\s+/).filter(Boolean);
      const index = await solutionsIndex(env, ctx);
      const matches = index.items.filter((item) => {
        if (platform && item.platform.toLowerCase() !== platform) return false;
        const haystack = `${item.title} ${item.path}`.toLowerCase();
        return words.every((word) => haystack.includes(word));
      });
      return { total: matches.length, items: matches.slice(0, limit) };
    },
  },
  {
    name: 'get_solution_source',
    title: '读取题解源码',
    description: '读取题解仓库里一个源码文件的全文（超过 60000 字符时截断）。path 来自 search_solutions。',
    inputSchema: object({ path: { type: 'string', minLength: 1, maxLength: 300 } }, ['path']),
    async run(args, env) {
      const path = solutionPath(text(args, 'path', { max: 300 }));
      if (!path) throw new ToolError('path 必须是题解仓库里的源码文件路径');
      const response = await fetchUpstream(solutionRawUrl(env, path), { ttl: 3600, accept: 'text/plain' });
      if (response.status === 404) throw new ToolError('没有这个文件');
      if (!response.ok) throw new ToolError(`题解仓库返回 ${response.status}`);
      const source = await response.text();
      return { path, truncated: source.length > 60000, source: source.slice(0, 60000) };
    },
  },
  {
    name: 'get_now_status',
    title: 'Mac 当前状态',
    description: 'Mac 的实时状态：是否在线、正在听的歌、前台应用、运行中的应用、电量和系统负载。离线时只返回 status: offline。',
    inputSchema: object(),
    async run(_args, env) {
      try {
        return await macStatus(env);
      } catch (error) {
        if (error instanceof UpstreamError) throw new ToolError(`状态暂时取不到：${error.message}`);
        throw error;
      }
    },
  },
  {
    name: 'get_health_summary',
    title: '健康指标',
    description: '健康指标卡：睡眠估算得分、睡眠时长、步数、活跃分钟、HRV、静息心率等的最新值、7/30 天均值和趋势（assessment 为 improving / worsening / stable）。还会列出可用于 get_health_series 的指标名。',
    inputSchema: object(),
    async run(_args, env) {
      const value = await snapshot(env, 'health', '健康');
      return { generated_at: value.generated_at ?? null, metrics: healthMetrics(value), available_metrics: availableMetrics(value, 'daily') };
    },
  },
  {
    name: 'get_health_series',
    title: '健康趋势序列',
    description: '健康数据的时间序列。daily 每天一个点，weekly 每周一个点；缺失值为 null，不是 0。',
    inputSchema: object({
      metrics: { type: 'array', items: { type: 'string', maxLength: 60 }, maxItems: 12, description: '指标名，留空取全部；名字见 get_health_summary 的 available_metrics' },
      granularity: { type: 'string', enum: ['daily', 'weekly'], default: 'daily' },
      limit: { type: 'integer', minimum: 1, maximum: 400, default: 60, description: '最后 N 个点' },
    }),
    async run(args, env) {
      const granularity = text(args, 'granularity', { values: ['daily', 'weekly'], fallback: 'daily' });
      const limit = integer(args, 'limit', { min: 1, max: 400, fallback: 60 });
      const metrics = args.metrics ?? [];
      if (!Array.isArray(metrics) || metrics.length > 12 || metrics.some((item) => typeof item !== 'string')) throw new ToolError('metrics 必须是最多 12 个字符串的数组');
      const value = await snapshot(env, 'health', '健康');
      return healthSeries(value, { metrics, granularity, limit });
    },
  },
  {
    name: 'get_ledger_summary',
    title: '收支概况',
    description: '某个月（默认最近一个有记录的月）的收入、支出、结余、储蓄率和按二级账户的支出构成，附上个月对比，以及当前总资产、总负债和净资产。金额单位是 currency。',
    inputSchema: object({ month: { type: 'string', pattern: MONTH, description: 'YYYY-MM' } }),
    async run(args, env) {
      const month = text(args, 'month', { pattern: MONTH });
      return ledgerSummary(await snapshot(env, 'ledger', '记账'), month || null);
    },
  },
  {
    name: 'get_ledger_monthly',
    title: '按月收支',
    description: '按月、按账户汇总的金额。prefix 过滤账户（如 Expenses 或 Expenses:Food），depth 决定合并到第几级。符号沿用 beancount：收入为负，支出为正。',
    inputSchema: object({
      prefix: { type: 'string', maxLength: 200, description: '账户前缀，默认 Income 和 Expenses 全部' },
      depth: { type: 'integer', minimum: 1, maximum: 6, default: 2 },
      months: { type: 'integer', minimum: 1, maximum: 24, default: 12 },
    }),
    async run(args, env) {
      const value = await snapshot(env, 'ledger', '记账');
      return ledgerMonthly(value, {
        prefix: text(args, 'prefix', { max: 200 }),
        depth: integer(args, 'depth', { min: 1, max: 6, fallback: 2 }),
        last: integer(args, 'months', { min: 1, max: 24, fallback: 12 }),
      });
    },
  },
  {
    name: 'get_ledger_balances',
    title: '账户余额',
    description: '资产和负债账户的当前余额（已按主币种折算）。负债为负数。',
    inputSchema: object({ prefix: { type: 'string', maxLength: 200, description: '账户前缀，例如 Assets:Bank' } }),
    async run(args, env) {
      const value = await snapshot(env, 'ledger', '记账');
      return { currency: value.currency, as_of: value.as_of ?? null, balances: ledgerBalances(value, { prefix: text(args, 'prefix', { max: 200 }) }) };
    },
  },
  {
    name: 'list_ledger_transactions',
    title: '近期交易',
    description: '最近的交易（面板只保存最近约 90 天），新的在前。可按日期、账户前缀和关键词（付款方、摘要、标签）过滤。',
    inputSchema: object({
      since: { type: 'string', pattern: DATE },
      account: { type: 'string', maxLength: 200, description: '账户前缀' },
      text: { type: 'string', maxLength: 100, description: '付款方、摘要或标签里的关键词' },
      limit: { type: 'integer', minimum: 1, maximum: 200, default: 50 },
    }),
    async run(args, env) {
      const value = await snapshot(env, 'ledger', '记账');
      return {
        currency: value.currency,
        transactions: ledgerTransactions(value, {
          since: text(args, 'since', { pattern: DATE }) || null,
          account: text(args, 'account', { max: 200 }),
          text: text(args, 'text', { max: 100 }),
          limit: integer(args, 'limit', { min: 1, max: 200, fallback: 50 }),
        }),
      };
    },
  },
].map((tool) => ({ ...tool, annotations: { title: tool.title, ...READ_ONLY } }));

function shift(day, amount) {
  return new Date(Date.parse(`${day}T00:00:00Z`) + amount * 86_400_000).toISOString().slice(0, 10);
}
