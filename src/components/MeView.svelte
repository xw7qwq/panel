<script>
  import { onMount } from 'svelte';
  import Card from '@xw7/ui/components/Card.svelte';
  import Notice from '@xw7/ui/components/Notice.svelte';
  import Skeleton from '@xw7/ui/components/Skeleton.svelte';
  import Stat from '@xw7/ui/components/Stat.svelte';
  import { formatDate, formatMoney, formatNumber, formatPercent } from '@xw7/ui/format';
  import { getJson } from '../lib/api.js';
  import NowCard from './NowCard.svelte';

  const KEY_METRICS = ['sleep_hours', 'steps', 'hrv', 'rhr'];

  let summary = $state.raw(null);
  let error = $state('');
  let grants = $state.raw(null);
  let grantsError = $state('');
  let origin = $state('https://lucius7.dev');
  let copied = $state(false);
  let now = $state(Date.now());

  onMount(() => {
    origin = location.origin;
    getJson('/api/v1/me/summary').then(
      (body) => (summary = body.data),
      (reason) => (error = reason.message),
    );
    loadGrants();
  });

  async function loadGrants() {
    try {
      grants = (await getJson('/api/v1/me/grants')).data;
      grantsError = '';
    } catch (reason) {
      grantsError = reason.message;
    }
  }

  async function revoke(grant) {
    if (!confirm(`撤销「${grant.client}」的授权？它将不能再读取面板数据。`)) return;
    const response = await fetch(`/api/v1/me/grants?id=${encodeURIComponent(grant.id)}`, { method: 'DELETE', credentials: 'same-origin' });
    if (!response.ok) grantsError = '撤销失败，请刷新后再试';
    await loadGrants();
  }

  async function copy() {
    try {
      await navigator.clipboard.writeText(`${origin}/mcp`);
      copied = true;
      setTimeout(() => (copied = false), 1500);
    } catch {
      copied = false;
    }
  }

  const ledger = $derived(summary?.ledger ?? null);
  const metrics = $derived((summary?.health?.metrics ?? []).filter((card) => KEY_METRICS.includes(card.key)));
</script>

<div class="page-head">
  <div>
    <h1>我的</h1>
    <p>只有自己能看到的部分，以及给 AI 用的只读接口。</p>
  </div>
  <form method="post" action="/logout/">
    <button class="xw7-button" type="submit">退出登录</button>
  </form>
</div>

{#if error}<Notice tone="bad">概览加载失败：{error}</Notice>{/if}

<div class="grid grid-2">
  <Card title="本月收支" subtitle={ledger?.month?.month ?? ''} href="/me/ledger/" hrefLabel="记账">
    {#if !summary && !error}
      <Skeleton lines={3} />
    {:else if !ledger?.month}
      <p class="xw7-muted">记账数据还没有推送过来。</p>
    {:else}
      <div class="stats">
        <Stat label="收入" value={formatMoney(ledger.month.income)} unit={ledger.currency} size="sm" />
        <Stat label="支出" value={formatMoney(ledger.month.expenses)} unit={ledger.currency} size="sm" />
        <Stat label="储蓄率" value={ledger.month.savings_rate == null ? '—' : formatNumber(ledger.month.savings_rate, 1)} unit={ledger.month.savings_rate == null ? '' : '%'} size="sm" />
        <Stat label="净资产" value={formatMoney(ledger.net_worth)} unit={ledger.currency} size="sm" />
      </div>
    {/if}
  </Card>

  <Card title="健康" subtitle={summary?.health?.generated_at ? `更新于 ${formatDate(summary.health.generated_at, true)}` : ''} href="/me/health/" hrefLabel="详细数据">
    {#if !summary && !error}
      <Skeleton lines={3} />
    {:else if !metrics.length}
      <p class="xw7-muted">健康数据还没有推送过来。</p>
    {:else}
      <div class="stats">
        {#each metrics as card (card.key)}
          <Stat
            label={card.label}
            value={formatNumber(card.latest, card.key === 'steps' ? 0 : 1)}
            unit={card.unit}
            size="sm"
            trend={card.trend?.percent == null ? null : { assessment: card.trend.assessment, text: formatPercent(card.trend.percent) }}
          />
        {/each}
      </div>
    {/if}
  </Card>

  <Card title="此刻" href="/now/" hrefLabel="详情">
    {#if !summary && !error}<Skeleton lines={3} />{:else}<NowCard status={summary?.now ?? null} {now} />{/if}
  </Card>

  <Card title="让 AI 读取面板" subtitle="MCP 连接器 · 只读">
    <p class="xw7-muted">在 Claude 等支持 MCP 的应用里添加自定义连接器，地址填下面这个。第一次连接会跳到这里登录并确认授权。</p>
    <div class="endpoint">
      <code>{origin}/mcp</code>
      <button type="button" class="xw7-button" onclick={copy}>{copied ? '已复制' : '复制'}</button>
    </div>
    <p class="xw7-faint small">可以读取刷题、题解、状态、健康和记账数据，不能修改任何东西。授权 30 天有效。</p>

    <h3 class="minor">已授权的应用</h3>
    {#if grantsError}
      <p class="xw7-muted">{grantsError}</p>
    {:else if !grants}
      <Skeleton lines={2} />
    {:else if !grants.length}
      <p class="xw7-faint">还没有授权过任何应用。</p>
    {:else}
      <ul class="row-list">
        {#each grants as grant (grant.id)}
          <li>
            <div class="grow">
              <div class="ellipsis">{grant.client}</div>
              <div class="xw7-faint small">授权于 {formatDate(grant.created_at, true)}{grant.expires_at ? ` · ${formatDate(grant.expires_at)} 到期` : ''}</div>
            </div>
            <button type="button" class="xw7-button" onclick={() => revoke(grant)}>撤销</button>
          </li>
        {/each}
      </ul>
    {/if}
  </Card>
</div>

<style>
  .endpoint {
    display: flex;
    align-items: center;
    gap: var(--space-2);
    margin: var(--space-3) 0;
  }

  .endpoint code {
    flex: 1;
    min-width: 0;
    padding: 0.4rem 0.6rem;
    overflow-x: auto;
    border-radius: var(--radius-2);
    background: var(--surface-2);
    font-family: var(--font-mono);
    font-size: var(--text-sm);
    white-space: nowrap;
  }

  .small {
    font-size: var(--text-xs);
  }

  .minor {
    margin: var(--space-5) 0 var(--space-1);
    color: var(--text-2);
    font-size: var(--text-sm);
    font-weight: 600;
  }
</style>
