<script>
  import { onMount } from 'svelte';
  import BarChart from '@xw7/ui/components/BarChart.svelte';
  import Card from '@xw7/ui/components/Card.svelte';
  import LineChart from '@xw7/ui/components/LineChart.svelte';
  import Notice from '@xw7/ui/components/Notice.svelte';
  import Skeleton from '@xw7/ui/components/Skeleton.svelte';
  import Stat from '@xw7/ui/components/Stat.svelte';
  import { formatDate, formatMoney, formatNumber, formatPercent } from '@xw7/ui/format';
  import { getJson } from '../lib/api.js';
  import { ledgerBalances, ledgerTransactions, monthSummary, months } from '../../worker/ledger.js';

  // 完整账本在 Fava 里看；这里是按月的概况。计算和 MCP 工具共用 worker/ledger.js。
  const FAVA = 'https://fava.lucius7.dev/';
  const STEP = 50;

  let snapshot = $state.raw(null);
  let error = $state('');
  let month = $state('');
  let text = $state('');
  let account = $state('');
  let shown = $state(STEP);

  onMount(() => {
    getJson('/api/v1/me/ledger').then(
      (body) => {
        snapshot = body.data;
        month = months(snapshot).at(-1) ?? '';
      },
      (reason) => (error = reason.message),
    );
  });

  const allMonths = $derived(snapshot ? months(snapshot) : []);
  const currency = $derived(snapshot?.currency ?? '');
  const current = $derived(snapshot && month ? monthSummary(snapshot, month) : null);
  const previous = $derived.by(() => {
    const index = allMonths.indexOf(month);
    return snapshot && index > 0 ? monthSummary(snapshot, allMonths[index - 1]) : null;
  });

  const recent = $derived.by(() => {
    if (!snapshot) return { labels: [], income: [], expenses: [] };
    const labels = allMonths.slice(-12);
    const rows = labels.map((item) => monthSummary(snapshot, item));
    return { labels, income: rows.map((row) => row.income), expenses: rows.map((row) => row.expenses) };
  });

  const worth = $derived(
    (snapshot?.net_worth ?? []).filter((row) => row.date).map((row) => ({ x: row.date, y: row.net ?? null })),
  );

  const balances = $derived.by(() => {
    if (!snapshot) return [];
    const groups = [
      { key: 'Assets', label: '资产', rows: [] },
      { key: 'Liabilities', label: '负债', rows: [] },
    ];
    for (const row of ledgerBalances(snapshot)) {
      if (Math.abs(row.amount) < 0.005) continue;
      groups.find((group) => row.account.startsWith(`${group.key}:`))?.rows.push(row);
    }
    return groups
      .map((group) => ({ ...group, total: group.rows.reduce((sum, row) => sum + row.amount, 0) }))
      .filter((group) => group.rows.length);
  });

  const accounts = $derived(
    snapshot ? [...new Set(snapshot.transactions.flatMap((entry) => entry.postings.map((posting) => posting.account.split(':').slice(0, 2).join(':'))))].sort() : [],
  );
  const transactions = $derived(snapshot ? ledgerTransactions(snapshot, { text, account, limit: snapshot.transactions.length }) : []);

  function change(now, before, higherIsBetter) {
    if (now == null || before == null || before === 0) return null;
    const percent = ((now - before) / Math.abs(before)) * 100;
    const assessment = Math.abs(percent) < 1 ? 'stable' : percent > 0 === higherIsBetter ? 'improving' : 'worsening';
    return { assessment, text: `${formatPercent(percent)} 较上月` };
  }

  function short(name) {
    return name.split(':').slice(1).join(':') || name;
  }

  // 一笔交易最能说明用途的那条分录：优先支出和收入账户。
  function headline(entry) {
    return entry.postings.find((posting) => /^(Expenses|Income):/.test(posting.account)) ?? entry.postings[0] ?? null;
  }
</script>

<div class="page-head">
  <div>
    <h1>记账</h1>
    <p>
      {#if snapshot}截至 {snapshot.as_of ?? '—'} · 金额折算为 {currency}{#if snapshot.generated_at}{` · 推送于 ${formatDate(snapshot.generated_at, true)}`}{/if}{:else}仅自己可见{/if}
    </p>
  </div>
  <div class="toolbar">
    {#if allMonths.length}
      <select class="select" bind:value={month} aria-label="月份">
        {#each allMonths.toReversed() as item (item)}<option value={item}>{item}</option>{/each}
      </select>
    {/if}
    <a class="xw7-button" href={FAVA} target="_blank" rel="noopener noreferrer">在 Fava 打开</a>
  </div>
</div>

{#if error}
  <Notice tone={error.includes('还没有') ? 'info' : 'bad'}>{error}</Notice>
{:else if !snapshot}
  <Card><Skeleton lines={6} /></Card>
{:else}
  <div class="grid">
    <Card title={`${month} 收支`}>
      {#if current}
        <div class="stats">
          <Stat label="收入" value={formatMoney(current.income)} unit={currency} trend={change(current.income, previous?.income, true)} />
          <Stat label="支出" value={formatMoney(current.expenses)} unit={currency} trend={change(current.expenses, previous?.expenses, false)} />
          <Stat label="结余" value={formatMoney(current.net)} unit={currency} />
          <Stat label="储蓄率" value={current.savings_rate == null ? '—' : formatNumber(current.savings_rate, 1)} unit={current.savings_rate == null ? '' : '%'} />
        </div>
      {:else}
        <p class="empty">这个月没有记录</p>
      {/if}
    </Card>

    <div class="grid grid-2">
      <Card title="近 12 个月" subtitle="收入与支出">
        <BarChart
          labels={recent.labels}
          series={[
            { label: '收入', color: 'var(--series-3)', values: recent.income },
            { label: '支出', color: 'var(--series-1)', values: recent.expenses },
          ]}
          xFormat={(label) => `${Number(label.slice(5))}月`}
          yFormat={(value) => formatNumber(value)}
          ariaLabel="近 12 个月的收入与支出"
        />
      </Card>
      <Card title="净资产" subtitle={snapshot.net_worth.length ? `${formatMoney(snapshot.net_worth.at(-1).net)} ${currency}` : ''}>
        {#if worth.length > 1}
          <LineChart
            series={[{ id: 'net', label: '净资产', color: 'var(--series-2)', points: worth }]}
            area
            height={220}
            xFormat={(day) => day.slice(0, 7)}
            yFormat={(value) => formatNumber(value)}
            ariaLabel="净资产走势"
          />
        {:else}
          <p class="empty">记录还不够画出走势</p>
        {/if}
      </Card>
    </div>

    <div class="grid grid-2">
      <Card title="支出构成" subtitle={month}>
        {#if !current?.categories.length}
          <p class="empty">这个月没有支出</p>
        {:else}
          <ul class="bars">
            {#each current.categories as row (row.account)}
              <li>
                <div class="bar-head">
                  <span class="ellipsis">{short(row.account)}</span>
                  <span class="xw7-num">{formatMoney(row.amount)}</span>
                </div>
                <div class="track"><span style:width={`${Math.max(1, (row.amount / current.categories[0].amount) * 100)}%`}></span></div>
              </li>
            {/each}
          </ul>
        {/if}
      </Card>
      <Card title="余额">
        {#each balances as group (group.key)}
          <h3 class="group">
            <span>{group.label}</span>
            <span class="xw7-num">{formatMoney(group.total)}</span>
          </h3>
          <ul class="row-list">
            {#each group.rows as row (row.account)}
              <li>
                <span class="grow ellipsis">{short(row.account)}</span>
                <span class="xw7-num">{formatMoney(row.amount)}</span>
              </li>
            {/each}
          </ul>
        {:else}
          <p class="empty">没有余额记录</p>
        {/each}
      </Card>
    </div>

    <Card title="交易" subtitle={`共 ${formatNumber(transactions.length)} 笔`}>
      {#snippet actions()}
        <div class="toolbar">
          <input class="xw7-input" type="search" placeholder="搜索收款方、备注、标签" value={text} oninput={(event) => ((text = event.currentTarget.value), (shown = STEP))} aria-label="搜索交易" />
          <select class="select" value={account} onchange={(event) => ((account = event.currentTarget.value), (shown = STEP))} aria-label="账户">
            <option value="">全部账户</option>
            {#each accounts as item (item)}<option value={item}>{item}</option>{/each}
          </select>
        </div>
      {/snippet}
      {#if !transactions.length}
        <p class="empty">没有匹配的交易</p>
      {:else}
        <ul class="row-list">
          {#each transactions.slice(0, shown) as entry, index (index)}
            {@const main = headline(entry)}
            <li>
              <time class="xw7-faint xw7-num day">{entry.date}</time>
              <div class="grow">
                <div class="ellipsis">{[entry.payee, entry.narration].filter(Boolean).join(' · ') || '（无备注）'}</div>
                <div class="xw7-faint meta ellipsis">
                  {main ? main.account : ''}{#each entry.tags ?? [] as tag (tag)}<span class="tag">#{tag}</span>{/each}
                </div>
              </div>
              {#if main}<span class="xw7-num amount" class:income={main.amount < 0}>{formatMoney(Math.abs(main.amount))}{main.currency && main.currency !== currency ? ` ${main.currency}` : ''}</span>{/if}
            </li>
          {/each}
        </ul>
        {#if shown < transactions.length}
          <button type="button" class="xw7-button more" onclick={() => (shown += STEP)}>再显示 {Math.min(STEP, transactions.length - shown)} 笔</button>
        {/if}
      {/if}
    </Card>
  </div>
{/if}

<style>
  .bars {
    display: grid;
    gap: var(--space-3);
    margin: 0;
    padding: 0;
    list-style: none;
  }

  .bar-head {
    display: flex;
    justify-content: space-between;
    gap: var(--space-3);
    font-size: var(--text-sm);
  }

  .track {
    height: 6px;
    margin-top: 4px;
    border-radius: var(--radius-pill);
    background: var(--surface-2);
  }

  .track span {
    display: block;
    height: 100%;
    border-radius: inherit;
    background: var(--series-1);
  }

  .group {
    display: flex;
    justify-content: space-between;
    margin: var(--space-4) 0 var(--space-1);
    color: var(--text-2);
    font-size: var(--text-sm);
    font-weight: 600;
  }

  .group:first-child {
    margin-top: 0;
  }

  .day {
    flex: none;
    font-size: var(--text-sm);
  }

  .meta {
    font-size: var(--text-xs);
  }

  .tag {
    margin-left: 6px;
  }

  .amount {
    flex: none;
    font-weight: 600;
  }

  .amount.income {
    color: var(--good);
  }

  .more {
    width: 100%;
    margin-top: var(--space-3);
  }
</style>
