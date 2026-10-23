import { readSession } from './auth.js';
import { healthMetrics } from './health.js';
import { HttpError, cacheControl, fail, ok, preflight, withCors } from './http.js';
import { ingest } from './ingest.js';
import { ledgerSummary } from './ledger.js';
import { publicOj } from './oj.js';
import {
  UpstreamError,
  blogLatest,
  fetchUpstream,
  macStatus,
  ojSummary,
  publicMacStatus,
  readHealthPublic,
  readSnapshot,
  solutionPath,
  solutionRawUrl,
  solutionsIndexResponse,
} from './sources.js';

// /api/v1：公开接口允许跨域读取并在边缘缓存；/api/v1/me/* 需要登录，从不缓存；/api/v1/ingest/* 只给服务器推送。
export const ROUTES = [
  { path: '/api/v1', public: true, handler: index, describe: '接口目录' },
  { path: '/api/v1/summary', public: true, handler: summary, describe: '首页和博客用的公开汇总：刷题、正在听的歌、上周平均睡眠和步数' },
  { path: '/api/v1/oj/summary', public: true, handler: ojSummaryRoute, describe: '刷题汇总：各平台题数与 rating、连续天数、每日首次 AC、最近通过' },
  { path: '/api/v1/oj/dashboard', public: true, handler: ojDashboard, describe: '刷题完整数据（约 5 MB），面板刷题页在浏览器里计算' },
  { path: '/api/v1/solutions/index', public: true, handler: solutionsRoute, describe: '题解索引：路径、标题、平台、提交时间' },
  { path: '/api/v1/solutions/file', public: true, handler: solutionFile, describe: '题解源码，参数 path' },
  { path: '/api/v1/now', public: true, handler: nowRoute, describe: 'Mac 当前状态的公开部分：在线与正在听的歌' },
  { path: '/api/v1/health/summary', public: true, handler: healthSummaryRoute, describe: '健康公开摘要：截至昨天的 7 天平均睡眠和步数' },
  { path: '/api/v1/blog/latest', public: true, handler: blogRoute, describe: '博客最新文章' },
  { path: '/api/v1/me', handler: me, describe: '登录状态' },
  { path: '/api/v1/me/summary', handler: meSummary, describe: '私人概览：本月收支、健康指标、Mac 完整状态' },
  { path: '/api/v1/me/now', handler: meNow, describe: 'Mac 完整状态：前台应用、电量、负载' },
  { path: '/api/v1/me/health', handler: meHealth, describe: '完整健康快照' },
  { path: '/api/v1/me/ledger', handler: meLedger, describe: '记账快照：余额、按月收支、净资产、近期交易' },
];

export async function api(request, env, ctx) {
  const url = new URL(request.url);
  const path = url.pathname.replace(/\/+$/, '') || '/';
  if (path.startsWith('/api/v1/ingest/')) return ingest(request, env, path.slice('/api/v1/ingest/'.length));
  const route = ROUTES.find((item) => item.path === path);
  if (!route) return fail(404, 'not_found', '没有这个接口', { cors: true });
  if (request.method === 'OPTIONS') return route.public ? preflight() : fail(405, 'method_not_allowed', '私有接口不支持跨域');
  if (request.method !== 'GET' && request.method !== 'HEAD') {
    return fail(405, 'method_not_allowed', '只支持 GET', { cors: route.public, headers: { Allow: 'GET, HEAD, OPTIONS' } });
  }
  if (!route.public && !(await readSession(request, env))) return fail(401, 'unauthorized', '需要登录');
  try {
    return await route.handler({ request, env, ctx, url });
  } catch (error) {
    if (error instanceof UpstreamError) return fail(502, 'upstream_unavailable', error.message, { cors: route.public });
    if (error instanceof HttpError) return fail(error.status, error.code, error.message, { cors: route.public });
    console.error(error);
    return fail(500, 'internal_error', '服务器出错了', { cors: route.public });
  }
}

// 公开汇总在 Cache API 里放一分钟，减少对上游的请求。
async function cached(ctx, url, ttl, produce) {
  const cache = globalThis.caches?.default;
  const key = new Request(url.toString());
  const hit = cache ? await cache.match(key) : null;
  if (hit) return hit;
  const response = await produce();
  if (cache && response.status === 200) ctx?.waitUntil?.(cache.put(key, response.clone()));
  return response;
}

// 代理上游文件：直接转发响应体，不在 Worker 里解析，CPU 开销几乎为零。
async function proxy(source, target, { ttl, type }) {
  let upstream;
  try {
    upstream = await fetchUpstream(target, { ttl, accept: type.split(';')[0] });
  } catch (error) {
    throw new UpstreamError(source, 502, `${source} 无法连接：${error.message}`);
  }
  if (!upstream.ok) throw new UpstreamError(source, upstream.status);
  return upstream;
}

function proxyHeaders(type, ttl) {
  return { 'Content-Type': type, 'Cache-Control': cacheControl(ttl), 'X-Content-Type-Options': 'nosniff' };
}

// JSON 文件也套上统一的 { data, updated_at, source } 信封：在流的首尾拼接，不解析中间的内容。
async function proxyJson(source, target, ttl) {
  const upstream = await proxy(source, target, { ttl, type: 'application/json' });
  const modified = Date.parse(upstream.headers.get('Last-Modified') || '');
  const updatedAt = Number.isNaN(modified) ? null : new Date(modified).toISOString();
  return withCors(new Response(envelopeStream(upstream.body, updatedAt, source), { headers: proxyHeaders('application/json; charset=utf-8', ttl) }));
}

export function envelopeStream(body, updatedAt, source) {
  const encoder = new TextEncoder();
  const { readable, writable } = new TransformStream();
  const writer = writable.getWriter();
  (async () => {
    await writer.write(encoder.encode('{"data":'));
    const reader = body.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      await writer.write(value);
    }
    await writer.write(encoder.encode(`,"updated_at":${JSON.stringify(updatedAt)},"source":${JSON.stringify(source)}}`));
    await writer.close();
  })().catch((error) => writer.abort(error).catch(() => {}));
  return readable;
}

function settled(result) {
  return result.status === 'fulfilled' ? 'ok' : result.reason instanceof UpstreamError ? `unavailable: ${result.reason.message}` : 'error';
}

function index({ url }) {
  const base = url.origin;
  return ok(
    {
      name: 'xw7 面板接口',
      docs: `${base}/about/`,
      mcp: `${base}/mcp`,
      endpoints: ROUTES.map((route) => ({ path: route.path, auth: route.public ? 'public' : 'session', describe: route.describe })),
    },
    { cache: 3600, cors: true },
  );
}

async function summary({ env, ctx, url }) {
  return cached(ctx, url, 60, async () => {
    const [oj, now, health] = await Promise.allSettled([ojSummary(env), macStatus(env), readHealthPublic(env)]);
    return ok(
      {
        oj: oj.status === 'fulfilled' ? publicOj(oj.value) : null,
        now: now.status === 'fulfilled' ? publicMacStatus(now.value) : null,
        health: health.status === 'fulfilled' ? health.value : null,
      },
      { updatedAt: new Date().toISOString(), source: { oj: settled(oj), now: settled(now), health: settled(health) }, cache: 60, cors: true },
    );
  });
}

function ojSummaryRoute({ env }) {
  return proxyJson('oj', `${env.OJ_DATA_BASE}/summary.json`, 300);
}

function ojDashboard({ env }) {
  return proxyJson('oj', `${env.OJ_DATA_BASE}/dashboard.json`, 600);
}

async function solutionsRoute({ env, ctx }) {
  const cached = await solutionsIndexResponse(env, ctx);
  return withCors(new Response(cached.body, { headers: proxyHeaders('application/json; charset=utf-8', 900) }));
}

// 源码按纯文本返回，方便直接下载或在浏览器里看。
async function solutionFile({ env, url }) {
  const path = solutionPath(url.searchParams.get('path'));
  if (!path) throw new HttpError(400, 'invalid_path', 'path 必须是题解仓库里的源码文件');
  const upstream = await proxy('solutions', solutionRawUrl(env, path), { ttl: 3600, type: 'text/plain' });
  return withCors(new Response(upstream.body, { headers: proxyHeaders('text/plain; charset=utf-8', 3600) }));
}

async function nowRoute({ env }) {
  const status = await macStatus(env);
  return ok(publicMacStatus(status), { updatedAt: status.updated_at ?? null, source: 'macflare', cache: 15, cors: true });
}

async function healthSummaryRoute({ env }) {
  const data = await readHealthPublic(env);
  if (!data) throw new HttpError(503, 'not_ready', '健康数据还没有推送过来');
  return ok(data, { updatedAt: data.generated_at, source: 'health', cache: 600, cors: true });
}

async function blogRoute({ env }) {
  return ok(await blogLatest(env, 5), { source: 'blog', cache: 1800, cors: true });
}

function me() {
  return ok({ signed_in: true, user: 'owner' });
}

async function meSummary({ env }) {
  const [health, ledger, now] = await Promise.allSettled([readSnapshot(env, 'health'), readSnapshot(env, 'ledger'), macStatus(env)]);
  const healthValue = health.status === 'fulfilled' ? health.value : null;
  const ledgerValue = ledger.status === 'fulfilled' ? ledger.value : null;
  return ok(
    {
      health: healthValue ? { generated_at: healthValue.generated_at ?? null, metrics: healthMetrics(healthValue) } : null,
      ledger: ledgerValue ? ledgerSummary(ledgerValue) : null,
      now: now.status === 'fulfilled' ? now.value : null,
    },
    { updatedAt: new Date().toISOString(), source: { health: settled(health), ledger: settled(ledger), now: settled(now) } },
  );
}

async function meNow({ env }) {
  const status = await macStatus(env);
  return ok(status, { updatedAt: status.updated_at ?? null, source: 'macflare' });
}

async function meHealth({ env }) {
  const snapshot = await readSnapshot(env, 'health');
  if (!snapshot) throw new HttpError(503, 'not_ready', '健康数据还没有推送过来');
  return ok(snapshot, { updatedAt: snapshot.generated_at ?? null, source: 'health' });
}

async function meLedger({ env }) {
  const snapshot = await readSnapshot(env, 'ledger');
  if (!snapshot) throw new HttpError(503, 'not_ready', '记账数据还没有推送过来');
  return ok(snapshot, { updatedAt: snapshot.generated_at ?? null, source: 'ledger' });
}
