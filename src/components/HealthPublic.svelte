<script>
  import { onMount } from 'svelte';
  import Card from '@xw7/ui/components/Card.svelte';
  import Notice from '@xw7/ui/components/Notice.svelte';
  import Skeleton from '@xw7/ui/components/Skeleton.svelte';
  import Stat from '@xw7/ui/components/Stat.svelte';
  import { formatDate, formatNumber, shiftDay } from '@xw7/ui/format';
  import { getJson, signedIn } from '../lib/api.js';
  import { HEALTH_PAGES } from '../lib/sections.js';
  import SubNav from './SubNav.svelte';

  let data = $state.raw(null);
  let error = $state('');
  let mine = $state(false);

  onMount(() => {
    mine = signedIn();
    getJson('/api/v1/health/summary').then(
      (body) => (data = body.data),
      (reason) => (error = reason.message),
    );
  });
</script>

<div class="page-head">
  <div>
    <h1>健康</h1>
    <p>手环数据的公开摘要：截至昨天的 7 天平均。</p>
  </div>
  {#if mine}<SubNav items={HEALTH_PAGES} current="public" label="健康" />{/if}
</div>

{#if error}
  <Notice tone={error.includes('还没有') ? 'info' : 'bad'}>{error}</Notice>
{:else}
  <div class="grid grid-2">
    <Card title="最近 7 天" subtitle={data ? `${shiftDay(data.as_of, -6)} 至 ${data.as_of}` : ''}>
      {#if !data}
        <Skeleton lines={3} />
      {:else}
        <div class="stats">
          <Stat label="平均睡眠" value={formatNumber(data.sleep_hours_avg7, 1)} unit="小时" size="lg" />
          <Stat label="平均步数" value={formatNumber(data.steps_avg7)} unit="步" size="lg" />
        </div>
        <p class="xw7-faint note">
          {data.days_with_data} / {data.window_days} 天有记录{#if data.generated_at}{` · 数据生成于 ${formatDate(data.generated_at, true)}`}{/if}
        </p>
      {/if}
    </Card>
    <Card title="为什么只公开这些" tone="flat">
      <p class="xw7-muted">
        心率、HRV、睡眠分期和每天的明细能看出作息和身体状况，所以只给自己看。公开的两项是周平均，并且不含今天，看不出某一天的具体情况。
      </p>
      {#if mine}
        <p class="link"><a href="/me/health/">查看详细数据 →</a></p>
      {/if}
    </Card>
  </div>
{/if}

<style>
  .note {
    margin-top: var(--space-3);
    font-size: var(--text-xs);
  }

  .link {
    margin-top: var(--space-3);
  }
</style>
