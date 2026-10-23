<script>
  import { onMount } from 'svelte';
  import Card from '@xw7/ui/components/Card.svelte';
  import Heatmap from '@xw7/ui/components/Heatmap.svelte';
  import Notice from '@xw7/ui/components/Notice.svelte';
  import PlatformTag from '@xw7/ui/components/PlatformTag.svelte';
  import Skeleton from '@xw7/ui/components/Skeleton.svelte';
  import Stat from '@xw7/ui/components/Stat.svelte';
  import { formatDate, formatNumber, relativeTime, shiftDay } from '@xw7/ui/format';
  import { SITES } from '@xw7/ui/nav';
  import { getJson, poll, safeUrl, signedIn } from '../lib/api.js';
  import NowCard from './NowCard.svelte';

  let summary = $state.raw(null);
  let summaryError = $state('');
  let posts = $state.raw(null);
  let postsError = $state('');
  let mine = $state(false);
  let now = $state(Date.now());

  onMount(() => {
    mine = signedIn();
    getJson('/api/v1/blog/latest').then(
      (body) => (posts = body.data),
      (error) => (postsError = error.message),
    );
    return poll(async () => {
      try {
        summary = await getJson('/api/v1/summary');
        summaryError = '';
      } catch (error) {
        if (!summary) summaryError = error.message;
      }
      now = Date.now();
    }, 60_000);
  });

  const oj = $derived(summary?.data?.oj ?? null);
  const status = $derived(summary?.data?.now ?? null);
  const health = $derived(summary?.data?.health ?? null);
</script>

<div class="page-head">
  <div>
    <h1>Lucius7 的面板</h1>
    <p>刷题、此刻在做什么、身体怎么样，每天自动更新。文章写在<a href={SITES.blog}>博客</a>。</p>
  </div>
  {#if mine}<a class="xw7-button" href="/me/">我的面板 →</a>{/if}
</div>

{#if summaryError}
  <Notice tone="bad">汇总数据暂时取不到：{summaryError}</Notice>
{/if}

<div class="grid home">
  <div class="oj">
    <Card title="刷题" subtitle="首次 AC 按天统计 · UTC+8" href="/oj/" hrefLabel="完整记录">
      {#if !summary}
        <Skeleton lines={5} />
      {:else if !oj}
        <p class="empty">刷题数据暂时取不到</p>
      {:else}
        <div class="stats">
          <Stat label="累计解题" value={formatNumber(oj.solved)} unit="题" size="lg" />
          <Stat label="今天" value={formatNumber(oj.counts?.today)} unit="题" />
          <Stat label="本月" value={formatNumber(oj.counts?.month)} unit="题" />
          <Stat label="连续" value={formatNumber(oj.streak?.current)} unit="天" hint={`最长 ${formatNumber(oj.streak?.longest)} 天`} />
        </div>
        {#if oj.today}
          <div class="heat">
            <Heatmap
              values={oj.daily}
              start={shiftDay(oj.today, -181)}
              end={oj.today}
              levels={[1, 3, 6, 10]}
              label={(day, count) => `${day}：${count} 道新题`}
              ariaLabel="最近半年每天的新题数"
            />
          </div>
        {/if}
        {#if oj.recent?.length}
          <h3 class="minor">最近通过</h3>
          <ul class="row-list">
            {#each oj.recent as item, index (index)}
              <li>
                <PlatformTag platform={item.platform} short />
                <a class="grow ellipsis" href={safeUrl(item.problem_url)} target="_blank" rel="noopener noreferrer">
                  {item.index ? `${item.index}. ` : ''}{item.title}
                </a>
                <span class="xw7-faint when">{relativeTime(item.accepted_at, now)}</span>
              </li>
            {/each}
          </ul>
        {/if}
      {/if}
    </Card>
  </div>

  <div class="side grid">
    <Card title="此刻" href="/now/" hrefLabel="详情">
      {#if !summary}<Skeleton lines={3} />{:else}<NowCard {status} {now} compact />{/if}
    </Card>

    <Card title="健康" subtitle="截至昨天的 7 天平均" href="/health/" hrefLabel="说明">
      {#if !summary}
        <Skeleton lines={2} />
      {:else if !health}
        <p class="xw7-muted">健康数据还没有同步过来。</p>
      {:else}
        <div class="stats two">
          <Stat label="睡眠" value={formatNumber(health.sleep_hours_avg7, 1)} unit="小时" />
          <Stat label="步数" value={formatNumber(health.steps_avg7)} unit="步" />
        </div>
        <p class="xw7-faint note">{shiftDay(health.as_of, -6)} 至 {health.as_of}，{health.days_with_data} 天有记录</p>
      {/if}
    </Card>
  </div>

  <div class="span-all">
    <Card title="博客" subtitle="最新文章" href={SITES.blog} hrefLabel="去博客">
      {#if postsError}
        <p class="xw7-muted">文章列表暂时取不到：{postsError}</p>
      {:else if !posts}
        <Skeleton lines={3} />
      {:else if !posts.length}
        <p class="empty">还没有文章</p>
      {:else}
        <ul class="row-list">
          {#each posts as post (post.url)}
            <li>
              <a class="grow ellipsis" href={safeUrl(post.url)}>{post.title}</a>
              {#if post.published_at}<span class="xw7-faint when">{formatDate(post.published_at)}</span>{/if}
            </li>
          {/each}
        </ul>
      {/if}
    </Card>
  </div>
</div>

<style>
  .home {
    grid-template-columns: minmax(0, 3fr) minmax(0, 2fr);
    align-items: start;
  }

  .side {
    align-content: start;
  }

  .heat {
    margin-top: var(--space-5);
  }

  .minor {
    margin: var(--space-5) 0 var(--space-1);
    color: var(--text-2);
    font-size: var(--text-sm);
    font-weight: 600;
  }

  .two {
    grid-template-columns: repeat(2, minmax(0, 1fr));
  }

  .note {
    margin-top: var(--space-3);
    font-size: var(--text-xs);
  }

  .when {
    flex: none;
    font-size: var(--text-xs);
  }

  @media (max-width: 880px) {
    .home {
      grid-template-columns: minmax(0, 1fr);
    }
  }
</style>
