<script>
  import { onMount } from 'svelte';
  import Card from '@xw7/ui/components/Card.svelte';
  import LineChart from '@xw7/ui/components/LineChart.svelte';
  import Notice from '@xw7/ui/components/Notice.svelte';
  import Segmented from '@xw7/ui/components/Segmented.svelte';
  import Skeleton from '@xw7/ui/components/Skeleton.svelte';
  import Stat from '@xw7/ui/components/Stat.svelte';
  import { dayKey, formatDate, formatDuration, formatNumber, formatPercent } from '@xw7/ui/format';
  import { getJson } from '../lib/api.js';
  import { metricPoints, toneColor, windowStart } from '../lib/health.js';
  import { HEALTH_PAGES } from '../lib/sections.js';
  import SubNav from './SubNav.svelte';

  // 图表顺序：睡眠、步数、恢复，其余指标按快照里的顺序跟在后面。
  const PREFERRED = ['sleep_hours', 'steps', 'hrv', 'rhr', 'sleep_score', 'active_zone_minutes', 'active_minutes', 'calories_out'];
  const DIGITS = { steps: 0, calories_out: 0, active_minutes: 0, active_zone_minutes: 0 };

  let snapshot = $state.raw(null);
  let error = $state('');
  let range = $state('90');
  let granularity = $state('daily');

  onMount(() => {
    getJson('/api/v1/me/health').then(
      (body) => (snapshot = body.data),
      (reason) => (error = reason.message),
    );
  });

  const cards = $derived(
    (snapshot?.metrics ?? []).toSorted((a, b) => rank(a.key) - rank(b.key)),
  );
  const series = $derived(snapshot?.[granularity] ?? snapshot?.daily ?? null);
  const since = $derived(windowStart(dayKey(), Number(range)));
  const charts = $derived.by(() => {
    if (!series) return [];
    return series.metrics
      .filter((metric) => PREFERRED.includes(metric.key))
      .toSorted((a, b) => rank(a.key) - rank(b.key))
      .map((metric) => ({
        ...metric,
        points: metricPoints(series, metric.key, { granularity: snapshot?.[granularity] ? granularity : 'daily', since }),
      }))
      .filter((metric) => metric.points.some((point) => point.y !== null));
  });

  function rank(key) {
    const index = PREFERRED.indexOf(key);
    return index === -1 ? PREFERRED.length : index;
  }

  function digits(key) {
    return DIGITS[key] ?? 1;
  }

  function trend(card) {
    if (!card.trend || card.trend.percent == null) return null;
    return { assessment: card.trend.assessment, text: `${formatPercent(card.trend.percent)} 较前 7 天` };
  }

  function hint(card) {
    const parts = [`7 天 ${formatNumber(card.avg7, digits(card.key))}`, `30 天 ${formatNumber(card.avg30, digits(card.key))}`];
    if (card.goal) parts.push(card.key === 'sleep_hours' ? `目标 ${formatNumber(card.goal / 60, 1)} 小时` : `目标 ${formatNumber(card.goal)}`);
    return parts.join(' · ');
  }

  const rangeOptions = [
    { value: '30', label: '30 天' },
    { value: '90', label: '90 天' },
    { value: '365', label: '一年' },
  ];
  const granularityOptions = [
    { value: 'daily', label: '按天' },
    { value: 'weekly', label: '按周' },
  ];
</script>

<div class="page-head">
  <div>
    <h1>健康 · 详细</h1>
    <p>{snapshot?.generated_at ? `服务器推送于 ${formatDate(snapshot.generated_at, true)}` : '服务器上的健康数据，仅自己可见'}</p>
  </div>
  <SubNav items={HEALTH_PAGES} current="detail" label="健康" />
</div>

{#if error}
  <Notice tone={error.includes('还没有') ? 'info' : 'bad'}>{error}</Notice>
{:else if !snapshot}
  <Card><Skeleton lines={6} /></Card>
{:else}
  <div class="cards">
    {#each cards as card (card.key)}
      <Card>
        <Stat
          label={card.label}
          value={formatNumber(card.latest, digits(card.key))}
          unit={card.unit}
          trend={trend(card)}
          hint={hint(card)}
          color={toneColor(card.tone)}
        />
        {#if card.latest_date}<p class="xw7-faint date">最新 {card.latest_date}</p>{/if}
      </Card>
    {/each}
  </div>

  <div class="controls toolbar">
    <Segmented options={rangeOptions} bind:value={range} label="时间范围" />
    {#if snapshot.weekly}<Segmented options={granularityOptions} bind:value={granularity} label="粒度" />{/if}
  </div>

  {#if !charts.length}
    <p class="empty">这段时间没有数据</p>
  {:else}
    <div class="grid grid-2">
      {#each charts as chart (chart.key)}
        <Card title={chart.label} subtitle={chart.unit}>
          <LineChart
            series={[{ id: chart.key, label: chart.label, color: toneColor(chart.tone), points: chart.points }]}
            area
            height={200}
            yFormat={(value) => formatNumber(value, digits(chart.key))}
            ariaLabel={`${chart.label}走势`}
          />
        </Card>
      {/each}
    </div>
  {/if}

  {#if snapshot.sleep?.length}
    <section class="section">
      <h2>最近的睡眠</h2>
      <Card>
        <div class="scroll-x">
          <table class="xw7-table">
            <thead>
              <tr><th>日期</th><th>得分</th><th>时长</th><th>深睡</th><th>REM</th><th>浅睡</th><th>清醒</th></tr>
            </thead>
            <tbody>
              {#each snapshot.sleep as row, index (index)}
                <tr>
                  <td>{row.date}</td>
                  <td class="xw7-num">{formatNumber(row.score)}</td>
                  <td class="xw7-num">{row.hours == null ? '—' : formatDuration(row.hours * 60)}</td>
                  <td class="xw7-num">{formatDuration(row.deep)}</td>
                  <td class="xw7-num">{formatDuration(row.rem)}</td>
                  <td class="xw7-num">{formatDuration(row.light)}</td>
                  <td class="xw7-num">{formatDuration(row.awake)}</td>
                </tr>
              {/each}
            </tbody>
          </table>
        </div>
      </Card>
    </section>
  {/if}
{/if}

<style>
  .cards {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(min(100%, 170px), 1fr));
    gap: var(--space-3);
  }

  .date {
    margin-top: var(--space-2);
    font-size: var(--text-xs);
  }

  .controls {
    margin: var(--space-5) 0 var(--space-4);
  }
</style>
