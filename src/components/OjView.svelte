<script>
  import { onMount } from 'svelte';
  import Card from '@xw7/ui/components/Card.svelte';
  import Heatmap from '@xw7/ui/components/Heatmap.svelte';
  import LineChart from '@xw7/ui/components/LineChart.svelte';
  import Notice from '@xw7/ui/components/Notice.svelte';
  import PlatformTag from '@xw7/ui/components/PlatformTag.svelte';
  import Segmented from '@xw7/ui/components/Segmented.svelte';
  import Skeleton from '@xw7/ui/components/Skeleton.svelte';
  import Stat from '@xw7/ui/components/Stat.svelte';
  import { dayKey, formatDate, formatNumber, shiftDay } from '@xw7/ui/format';
  import { PLATFORMS } from '@xw7/ui/platforms';
  import { getJson, safeUrl } from '../lib/api.js';
  import {
    ACTIVE_PLATFORMS,
    activeDashboard,
    completion,
    contestMatrix,
    cumulative,
    dailyCounts,
    epochDay,
    firstAccepted,
    matchesStatus,
    streaks,
  } from '../lib/oj.js';
  import { OJ_PAGES } from '../lib/sections.js';
  import SubNav from './SubNav.svelte';

  const PAGE_SIZE = 15;
  const LEVELS = [1, 3, 6, 10];
  const weekday = new Intl.DateTimeFormat('zh-CN', { timeZone: 'UTC', weekday: 'long' });

  let data = $state.raw(null);
  let error = $state('');
  let today = $state(dayKey());
  let platform = $state('all');
  let range = $state('all');
  let year = $state(Number(dayKey().slice(0, 4)));
  let date = $state(dayKey());
  let mode = $state('first');
  let search = $state('');
  let kind = $state('all');
  let status = $state('all');
  let page = $state(1);
  let dailySection = $state(null);

  onMount(() => {
    const controller = new AbortController();
    getJson('/api/v1/oj/dashboard', { signal: controller.signal }).then(
      ({ data: raw }) => {
        if (raw?.schemaVersion !== 2 || !Array.isArray(raw.problems) || !raw.sources) {
          error = '不支持的数据格式';
          return;
        }
        data = activeDashboard(raw);
        const latest = data.accepted.reduce((best, event) => (!best || event.epoch > best.epoch ? event : best), null);
        if (latest) choose(epochDay(latest.epoch));
      },
      (reason) => {
        if (reason.name !== 'AbortError') error = reason.message;
      },
    );
    // 跨过零点后“今天”跟着变。
    const timer = setInterval(() => {
      const current = dayKey();
      if (current === today) return;
      if (date === today) date = current;
      today = current;
    }, 60_000);
    return () => {
      controller.abort();
      clearInterval(timer);
    };
  });

  const inPlatform = (item) => platform === 'all' || item.platform === platform;

  // 和平台筛选无关的部分只算一次。
  const base = $derived.by(() => {
    if (!data) return null;
    const problems = new Map(data.problems.map((problem) => [problem.id, problem]));
    const first = firstAccepted(data.accepted);
    const attempted = new Set(data.attempted);
    const solved = new Set([...data.accepted.map((event) => event.problemId), ...data.undatedSolved]);
    const undated = new Set(data.undatedSolved.filter((id) => !first.has(id)));
    const solvedBy = {};
    for (const id of solved) {
      const owner = problems.get(id)?.platform;
      if (owner) solvedBy[owner] = (solvedBy[owner] || 0) + 1;
    }
    const contests = data.contests
      .map((contest) => ({ ...contest, progress: completion(contest, first, attempted) }))
      .sort(
        (a, b) =>
          (b.startEpoch || b.lastSubmissionEpoch || 0) - (a.startEpoch || a.lastSubmissionEpoch || 0) ||
          b.id.localeCompare(a.id, undefined, { numeric: true }),
      );
    const years = new Set(data.accepted.map((event) => Number(epochDay(event.epoch).slice(0, 4))));
    return { problems, first, attempted, solved, undated, solvedBy, contests, years };
  });

  const view = $derived.by(() => {
    if (!base) return null;
    const events = data.accepted.filter(inPlatform);
    const firsts = [...base.first.values()].filter(inPlatform);
    const solved = [...base.solved].map((id) => base.problems.get(id)).filter((problem) => problem && inPlatform(problem));
    return { events, firsts, solved, counts: dailyCounts(firsts) };
  });

  const connected = $derived(platform === 'all' || Boolean(data?.sources[platform]?.lastSuccess));

  const stats = $derived.by(() => {
    if (!view) return null;
    const month = today.slice(0, 7);
    return {
      total: view.solved.length,
      today: view.counts[today] || 0,
      todayAc: view.events.filter((event) => epochDay(event.epoch) === today).length,
      month: view.firsts.filter((event) => epochDay(event.epoch).startsWith(month)).length,
      streak: streaks(Object.keys(view.counts), today),
      undated: view.solved.filter((problem) => base.undated.has(problem.id)).length,
      split: ACTIVE_PLATFORMS.filter((id) => inPlatform({ platform: id }) && data.sources[id]?.lastSuccess).map((id) => ({
        id,
        count: base.solvedBy[id] || 0,
      })),
    };
  });

  const trend = $derived.by(() => {
    if (!view?.firsts.length) return [];
    const earliest = view.firsts.reduce((min, event) => Math.min(min, event.epoch), Infinity);
    let start = shiftDay(epochDay(earliest), -1);
    const limit = range === 'year' ? shiftDay(today, -364) : range === 'quarter' ? shiftDay(today, -89) : null;
    if (limit && limit > start) start = limit;
    return cumulative(view.counts, start, today);
  });

  const years = $derived(base ? [...new Set([Number(today.slice(0, 4)), year, ...base.years])].sort((a, b) => b - a) : [year]);
  const yearEnd = $derived(String(year) === today.slice(0, 4) ? today : `${year}-12-31`);
  const yearSummary = $derived.by(() => {
    if (!view) return { total: 0, days: 0 };
    const entries = Object.entries(view.counts).filter(([day]) => day.startsWith(`${year}-`));
    return { total: entries.reduce((sum, [, count]) => sum + count, 0), days: entries.length };
  });

  const daily = $derived.by(() => {
    if (!view) return { list: [], fresh: 0, all: 0 };
    const all = view.events.filter((event) => epochDay(event.epoch) === date);
    const list = (mode === 'all' ? all : view.firsts.filter((event) => epochDay(event.epoch) === date)).sort(
      (a, b) => b.epoch - a.epoch || b.id - a.id,
    );
    return { list, fresh: view.counts[date] || 0, all: all.length };
  });

  const profiles = $derived.by(() => {
    if (!data) return [];
    return Object.entries(data.sources)
      .filter(([id]) => inPlatform({ platform: id }))
      .map(([id, source]) => {
        const solved = base.solvedBy[id] || 0;
        const profile = source.profile || {};
        const detail = !source.lastSuccess
          ? '等待连接提交记录'
          : id === 'qoj'
            ? `${formatNumber(solved)} 题已 AC · 有提交的比赛`
            : `${formatNumber(solved)} 题已 AC · ${profile.rank || (id === 'atcoder' ? 'Algorithm' : '暂无段位')}`;
        const rating =
          id === 'qoj'
            ? { value: source.submissionCount != null ? formatNumber(source.submissionCount) : '—', label: '提交记录' }
            : { value: profile.rating ?? '—', label: profile.maxRating == null ? 'Rating' : `Rating · 最高 ${profile.maxRating}` };
        return { id, url: safeUrl(profile.url), detail, rating };
      });
  });

  const alerts = $derived.by(() => {
    if (!data) return [];
    const result = [];
    for (const [id, source] of Object.entries(data.sources)) {
      const name = PLATFORMS[id]?.name ?? id;
      if (!source.lastSuccess) {
        result.push(`${name} 尚未连接，未计入统计。${source.message || '等待首次同步。'}`);
        continue;
      }
      if (source.collectionMethod === 'browser_import') result.push(`${name} 展示 ${formatDate(source.lastSuccess, true)} 手动导入的记录。`);
      else if (source.error || Date.now() - Date.parse(source.lastSuccess) > 36 * 3600 * 1000) {
        result.push(`${name} 暂未更新，展示 ${formatDate(source.lastSuccess, true)} 的记录。`);
      }
      if (source.warnings?.length) result.push(`${name}：${source.warnings.join('；')}`);
    }
    return result;
  });

  const kinds = $derived(base ? [...new Set(base.contests.filter(inPlatform).map((contest) => contest.kind))].sort() : []);
  const activeKind = $derived(kinds.includes(kind) ? kind : 'all');
  const filtered = $derived.by(() => {
    if (!base) return [];
    const query = search.toLocaleLowerCase().trim();
    return base.contests.filter((contest) => {
      if (!inPlatform(contest) || (activeKind !== 'all' && contest.kind !== activeKind)) return false;
      if (!matchesStatus(contest.progress, status)) return false;
      if (!query) return true;
      if (`${contest.name} ${contest.id}`.toLowerCase().includes(query)) return true;
      return contest.problems.some((id) => `${base.problems.get(id)?.name || ''} ${id}`.toLowerCase().includes(query));
    });
  });
  const pages = $derived(Math.max(1, Math.ceil(filtered.length / PAGE_SIZE)));
  const current = $derived(Math.min(page, pages));
  const matrix = $derived(base ? contestMatrix(filtered.slice((current - 1) * PAGE_SIZE, current * PAGE_SIZE), base.problems) : null);

  const platformOptions = [{ value: 'all', label: '全部' }, ...ACTIVE_PLATFORMS.map((id) => ({ value: id, label: PLATFORMS[id].name }))];
  const rangeOptions = [
    { value: 'all', label: '全部' },
    { value: 'year', label: '一年' },
    { value: 'quarter', label: '90 天' },
  ];
  const modeOptions = [
    { value: 'first', label: '首次 AC' },
    { value: 'all', label: '全部 AC' },
  ];

  function choose(day, scroll = false) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(day) || day > today) return;
    date = day;
    year = Number(day.slice(0, 4));
    if (scroll) dailySection?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }

  function taskTitle(index, problem, accepted, mark) {
    const state = accepted ? `首次 AC ${formatDate(accepted.epoch, true)}` : mark === 'attempted' ? '已尝试，尚未 AC' : '尚未完成';
    return `${index}. ${problem.name} · ${state}${problem.difficulty != null ? ` · 难度 ${problem.difficulty}` : ''}`;
  }
</script>

<div class="page-head">
  <div>
    <h1>刷题</h1>
    <p>
      {#if data}更新于 {formatDate(data.generatedAt, true)} · 日期按 UTC+8{:else}AtCoder、Codeforces、QOJ、牛客的提交记录{/if}
    </p>
  </div>
  <SubNav items={OJ_PAGES} current="stats" label="刷题" />
</div>

{#if data}
  <div class="filter">
    <Segmented options={platformOptions} bind:value={() => platform, (value) => ((platform = value), (page = 1))} label="平台" />
  </div>
{/if}

{#if error}
  <Notice tone="bad">刷题记录加载失败：{error}</Notice>
{:else if !data}
  <Card><Skeleton lines={6} /><p class="xw7-faint loading">正在加载完整记录（约 5 MB）…</p></Card>
{:else}
  {#if alerts.length}
    <div class="alerts">
      {#each alerts as message, index (index)}<Notice tone="warn">{message}</Notice>{/each}
    </div>
  {/if}

  <div class="grid">
    <Card title="累计解题" subtitle={connected ? stats.split.map((item) => `${PLATFORMS[item.id].name} ${formatNumber(item.count)}`).join(' / ') : '等待首次同步'}>
      {#snippet actions()}
        <Segmented options={rangeOptions} bind:value={range} label="时间范围" size="sm" />
      {/snippet}
      <div class="stats">
        <Stat label="累计" value={connected ? formatNumber(stats.total) : '—'} unit="题" size="lg" />
        <Stat label="今天" value={formatNumber(stats.today)} unit="题" hint={`${stats.todayAc} 次 AC，含重复通过`} />
        <Stat label="本月" value={formatNumber(stats.month)} unit="题" hint="首次 AC" />
        <Stat label="连续" value={formatNumber(stats.streak.current)} unit="天" hint={`最长 ${formatNumber(stats.streak.longest)} 天`} />
      </div>
      <div class="chart">
        {#if trend.length}
          <LineChart
            series={[{ id: 'total', label: '累计题数', color: 'var(--series-1)', points: trend }]}
            area
            height={240}
            xFormat={(day) => (range === 'all' ? day.slice(0, 7) : day.slice(5))}
            yFormat={(value) => formatNumber(value)}
            ariaLabel="按首次 AC 时间累计的解题数"
          />
        {:else}
          <p class="empty">还没有可绘制的 AC 记录</p>
        {/if}
      </div>
      <p class="xw7-faint note">
        {stats.undated ? `另有 ${formatNumber(stats.undated)} 题时间未知，未计入曲线` : '按首次 AC 时间累计'}
      </p>
    </Card>

    <div class="profiles">
      {#each profiles as profile (profile.id)}
        <div class="profile">
          <PlatformTag platform={profile.id} short />
          <div class="grow">
            <a class="name" href={profile.url} target="_blank" rel="noopener noreferrer">{PLATFORMS[profile.id]?.name ?? profile.id}</a>
            <div class="xw7-faint detail">{profile.detail}</div>
          </div>
          <div class="rating">
            <strong class="xw7-num">{profile.rating.value}</strong>
            <small>{profile.rating.label}</small>
          </div>
        </div>
      {/each}
    </div>

    <Card title="刷题日历" subtitle={`${year} 年解开 ${formatNumber(yearSummary.total)} 道新题，留下 ${yearSummary.days} 天足迹`}>
      {#snippet actions()}
        <select class="select" bind:value={year} aria-label="年份">
          {#each years as option (option)}<option value={option}>{option}</option>{/each}
        </select>
      {/snippet}
      <Heatmap
        values={view.counts}
        start={`${year}-01-01`}
        end={yearEnd}
        levels={LEVELS}
        selected={date}
        label={(day, count) => `${day}：${count} 道首次 AC`}
        onselect={(day) => choose(day, true)}
        ariaLabel={`${year} 年每天的首次 AC 数`}
      />
    </Card>

    <div bind:this={dailySection} class="anchor">
      <Card title={`${Number(date.slice(5, 7))} 月 ${Number(date.slice(8))} 日 · ${weekday.format(new Date(`${date}T00:00:00Z`))}`} subtitle={`${date} · ${daily.fresh} 道新题 · ${daily.all} 次 AC`}>
        {#snippet actions()}
          <div class="toolbar">
            <Segmented options={modeOptions} bind:value={mode} label="记录类型" size="sm" />
            <div class="days">
              <button type="button" class="xw7-button" onclick={() => choose(shiftDay(date, -1))} aria-label="前一天">‹</button>
              <input class="xw7-input date" type="date" value={date} max={today} onchange={(event) => choose(event.currentTarget.value)} aria-label="日期" />
              <button type="button" class="xw7-button" onclick={() => choose(shiftDay(date, 1))} disabled={date >= today} aria-label="后一天">›</button>
              <button type="button" class="xw7-button" onclick={() => choose(today)}>今天</button>
            </div>
          </div>
        {/snippet}
        {#if !daily.list.length}
          <p class="empty">
            {mode === 'first' && daily.all ? '这一天复习了已经解开的题目，切换到「全部 AC」查看。' : '这一天没有 AC 记录。'}
          </p>
        {:else}
          <ul class="row-list">
            {#each daily.list as event (event.id)}
              {@const problem = base.problems.get(event.problemId)}
              {@const isFirst = base.first.get(event.problemId)?.id === event.id}
              <li>
                <time class="xw7-num xw7-faint clock" datetime={new Date(event.epoch * 1000).toISOString()}>{formatDate(event.epoch, true).slice(11)}</time>
                <PlatformTag platform={event.platform} short />
                <div class="grow">
                  <a class="ellipsis problem" href={safeUrl(problem?.url || event.url)} target="_blank" rel="noopener noreferrer">
                    {problem?.index ? `${problem.index}. ` : ''}{problem?.name || event.problemId}
                  </a>
                  <div class="xw7-faint meta">
                    {#if problem?.difficulty != null}{event.platform === 'atcoder' ? '估计难度' : 'Rating'} {problem.difficulty} · {/if}
                    <a href={safeUrl(event.url)} target="_blank" rel="noopener noreferrer">提交记录</a>
                  </div>
                </div>
                <span class="badge" class:good={isFirst}>{isFirst ? '首次 AC' : '再次 AC'}</span>
              </li>
            {/each}
          </ul>
        {/if}
      </Card>
    </div>

    <Card title="比赛" subtitle={`共 ${formatNumber(filtered.length)} 场有提交的比赛`}>
      <div class="toolbar filters">
        <input
          class="xw7-input"
          type="search"
          placeholder="搜索比赛或题目"
          value={search}
          oninput={(event) => ((search = event.currentTarget.value), (page = 1))}
          aria-label="搜索比赛或题目"
        />
        <select class="select" value={activeKind} onchange={(event) => ((kind = event.currentTarget.value), (page = 1))} aria-label="比赛类别">
          <option value="all">所有类别</option>
          {#each kinds as option (option)}<option value={option}>{option}</option>{/each}
        </select>
        <select class="select" value={status} onchange={(event) => ((status = event.currentTarget.value), (page = 1))} aria-label="完成情况">
          <option value="all">全部</option>
          <option value="completed">已全部完成</option>
          <option value="unfinished">还有没做完的</option>
        </select>
      </div>
      {#if !matrix.rows.length}
        <p class="empty">没有符合条件的比赛，试试其他平台、类别，或清空搜索。</p>
      {:else}
        <div class="scroll-x">
          <table class="matrix" style:--columns={Math.max(1, matrix.columns.length)}>
            <thead>
              <tr>
                <th scope="col" class="contest">比赛</th>
                {#each matrix.columns as column (column.key)}<th scope="col">{column.label}</th>{/each}
              </tr>
            </thead>
            <tbody>
              {#each matrix.rows as row (row.contest.id)}
                <tr>
                  <th scope="row" class="contest">
                    <a href={safeUrl(row.contest.url)} target="_blank" rel="noopener noreferrer">{row.contest.name}</a>
                    <div class="xw7-faint meta">
                      {row.contest.kind}
                      {#if row.contest.startEpoch}· {formatDate(row.contest.startEpoch)}{/if}
                      · <span class:done={row.contest.progress.complete}>{row.contest.progress.solved} / {row.contest.catalogComplete ? row.contest.progress.total : '?'} 题</span>
                    </div>
                  </th>
                  {#each matrix.columns as column (column.key)}
                    {@const entries = row.cells.get(column.key) || []}
                    <td>
                      {#if !entries.length}<span class="xw7-faint">—</span>{/if}
                      {#each entries as entry (entry.id)}
                        {@const problem = base.problems.get(entry.id)}
                        {@const accepted = base.first.get(entry.id)}
                        {@const mark = accepted ? 'solved' : base.attempted.has(entry.id) ? 'attempted' : 'unseen'}
                        <a
                          class="task {mark}"
                          href={safeUrl(problem.url)}
                          target="_blank"
                          rel="noopener noreferrer"
                          title={taskTitle(entry.index, problem, accepted, mark)}
                        >
                          <span class="ellipsis">{entry.index}. {problem.name}</span>
                          {#if problem.difficulty != null}<small class="xw7-num">{problem.difficulty}</small>{/if}
                        </a>
                      {/each}
                    </td>
                  {/each}
                </tr>
              {/each}
            </tbody>
          </table>
        </div>
        <div class="pager">
          <button type="button" class="xw7-button" disabled={current === 1} onclick={() => (page = current - 1)}>上一页</button>
          <span class="xw7-muted xw7-num">{current} / {pages}</span>
          <button type="button" class="xw7-button" disabled={current === pages} onclick={() => (page = current + 1)}>下一页</button>
        </div>
      {/if}
    </Card>
  </div>
{/if}

<style>
  .filter {
    margin-bottom: var(--space-4);
  }

  .loading {
    margin-top: var(--space-3);
    font-size: var(--text-sm);
  }

  .alerts {
    display: grid;
    gap: var(--space-2);
    margin-bottom: var(--space-4);
  }

  .chart {
    margin-top: var(--space-5);
  }

  .note {
    margin-top: var(--space-2);
    font-size: var(--text-xs);
  }

  .profiles {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(min(100%, 240px), 1fr));
    gap: var(--space-3);
  }

  .profile {
    display: flex;
    align-items: center;
    gap: var(--space-3);
    padding: var(--space-3) var(--space-4);
    border: 1px solid var(--border);
    border-radius: var(--radius-3);
    background: var(--surface);
  }

  .name {
    color: var(--text);
    font-weight: 600;
  }

  .detail {
    font-size: var(--text-xs);
  }

  .rating {
    display: grid;
    justify-items: end;
    text-align: right;
  }

  .rating strong {
    font-size: var(--text-lg);
  }

  .rating small {
    color: var(--text-3);
    font-size: var(--text-xs);
    white-space: nowrap;
  }

  .anchor {
    scroll-margin-top: calc(var(--topbar-height) + var(--space-3));
  }

  .days {
    display: flex;
    align-items: center;
    gap: var(--space-1);
  }

  .date {
    width: auto;
  }

  .clock {
    flex: none;
    width: 3.2em;
    font-size: var(--text-sm);
  }

  .problem {
    display: block;
    color: var(--text);
  }

  .meta {
    font-size: var(--text-xs);
  }

  .matrix {
    width: 100%;
    min-width: calc(220px + var(--columns) * 120px);
    border-collapse: collapse;
    font-size: var(--text-sm);
    table-layout: fixed;
  }

  .matrix th,
  .matrix td {
    padding: var(--space-2);
    border-bottom: 1px solid var(--border);
    text-align: left;
    vertical-align: top;
  }

  .matrix thead th {
    color: var(--text-3);
    font-size: var(--text-xs);
    font-weight: 600;
  }

  .matrix .contest {
    width: 220px;
    font-weight: 400;
  }

  .matrix .contest a {
    color: var(--text);
    font-weight: 600;
  }

  .done {
    color: var(--good);
    font-weight: 600;
  }

  .task {
    display: flex;
    align-items: baseline;
    justify-content: space-between;
    gap: 4px;
    margin-bottom: 2px;
    padding: 2px 6px;
    border-radius: var(--radius-1);
    color: var(--text-2);
    font-size: var(--text-xs);
    text-decoration: none;
  }

  .task.solved {
    background: var(--good-soft);
    color: var(--good);
    font-weight: 600;
  }

  .task.attempted {
    background: var(--warn-soft);
    color: var(--warn);
  }

  .task.unseen {
    background: var(--surface-2);
  }

  .task small {
    flex: none;
    opacity: 0.8;
  }

  .filters {
    margin-bottom: var(--space-4);
  }

  .filters .xw7-input {
    flex: 1 1 220px;
    max-width: 360px;
  }

  .pager {
    display: flex;
    align-items: center;
    justify-content: center;
    gap: var(--space-3);
    margin-top: var(--space-4);
  }
</style>
