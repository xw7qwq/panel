<script>
  import { onMount } from 'svelte';
  import Card from '@xw7/ui/components/Card.svelte';
  import Notice from '@xw7/ui/components/Notice.svelte';
  import PlatformTag from '@xw7/ui/components/PlatformTag.svelte';
  import Skeleton from '@xw7/ui/components/Skeleton.svelte';
  import { formatDate, formatNumber } from '@xw7/ui/format';
  import { getJson, getText, safeUrl } from '../lib/api.js';
  import { highlight } from '../lib/highlight.js';
  import { OJ_PAGES } from '../lib/sections.js';
  import SubNav from './SubNav.svelte';

  const STEP = 60;

  let index = $state.raw(null);
  let error = $state('');
  let query = $state('');
  let platform = $state('all');
  let shown = $state(STEP);
  let selected = $state.raw(null);
  let source = $state('');
  let sourceError = $state('');
  let loading = $state(false);
  let copied = $state(false);
  let ticket = 0;

  onMount(() => {
    getJson('/api/v1/solutions/index').then(
      (body) => {
        index = body.data;
        syncFromUrl();
      },
      (reason) => (error = reason.message),
    );
    addEventListener('popstate', syncFromUrl);
    return () => removeEventListener('popstate', syncFromUrl);
  });

  function syncFromUrl() {
    const path = new URL(location.href).searchParams.get('path');
    if (path) open(path, false);
    else selected = null;
  }

  const platforms = $derived.by(() => {
    if (!index) return [];
    const counts = new Map();
    for (const item of index.items) counts.set(item.platform, (counts.get(item.platform) || 0) + 1);
    return [...counts].sort((a, b) => b[1] - a[1]).map(([name, count]) => ({ name, count }));
  });

  const results = $derived.by(() => {
    if (!index) return [];
    const words = query.toLowerCase().split(/\s+/).filter(Boolean);
    return index.items
      .filter((item) => platform === 'all' || item.platform === platform)
      .filter((item) => words.every((word) => `${item.title} ${item.path}`.toLowerCase().includes(word)))
      .sort((a, b) => (b.submitted_at || '').localeCompare(a.submitted_at || '') || a.path.localeCompare(b.path));
  });

  const githubUrl = $derived(
    selected && index?.repository ? `${index.repository.url}/blob/${index.repository.branch}/${selected.path.split('/').map(encodeURIComponent).join('/')}` : null,
  );
  const html = $derived(source ? highlight(source, selected?.language || 'C++') : '');

  async function open(path, push = true) {
    const item = index?.items.find((entry) => entry.path === path) ?? { path, title: path.split('/').pop(), platform: path.split('/')[0] };
    selected = item;
    source = '';
    sourceError = '';
    copied = false;
    loading = true;
    if (push) history.pushState(null, '', `?path=${encodeURIComponent(path)}`);
    const mine = ++ticket;
    try {
      const text = await getText(`/api/v1/solutions/file?path=${encodeURIComponent(path)}`);
      if (mine === ticket) source = text;
    } catch (reason) {
      if (mine === ticket) sourceError = reason.message;
    } finally {
      if (mine === ticket) loading = false;
    }
  }

  function close() {
    selected = null;
    history.pushState(null, '', location.pathname);
  }

  async function copy() {
    try {
      await navigator.clipboard.writeText(source);
      copied = true;
      setTimeout(() => (copied = false), 1500);
    } catch {
      copied = false;
    }
  }
</script>

<div class="page-head">
  <div>
    <h1>题解</h1>
    <p>
      {#if index}{formatNumber(index.count)} 份代码，{index.repository ? '来自题解仓库' : ''}{#if index.generated_at}，更新于 {formatDate(index.generated_at, true)}{/if}{:else}刷题时写下的代码{/if}
    </p>
  </div>
  <SubNav items={OJ_PAGES} current="code" label="刷题" />
</div>

{#if error}
  <Notice tone="bad">题解索引加载失败：{error}</Notice>
{:else if !index}
  <Card><Skeleton lines={8} /></Card>
{:else}
  <div class="layout" class:reading={selected}>
    <div class="list">
      <Card>
        <div class="toolbar filters">
          <input
            class="xw7-input"
            type="search"
            placeholder="搜索题名或路径，空格分隔"
            value={query}
            oninput={(event) => ((query = event.currentTarget.value), (shown = STEP))}
            aria-label="搜索题解"
          />
          <select class="select" value={platform} onchange={(event) => ((platform = event.currentTarget.value), (shown = STEP))} aria-label="平台">
            <option value="all">全部平台</option>
            {#each platforms as item (item.name)}<option value={item.name}>{item.name}（{item.count}）</option>{/each}
          </select>
        </div>
        <p class="xw7-faint count">找到 {formatNumber(results.length)} 份</p>
        {#if !results.length}
          <p class="empty">没有匹配的题解</p>
        {:else}
          <ul class="row-list">
            {#each results.slice(0, shown) as item (item.path)}
              <li class:active={selected?.path === item.path}>
                <PlatformTag platform={item.platform} short />
                <a
                  class="grow ellipsis"
                  href={`?path=${encodeURIComponent(item.path)}`}
                  onclick={(event) => {
                    event.preventDefault();
                    open(item.path);
                  }}
                >
                  {item.title}
                </a>
                {#if item.submitted_at}<span class="xw7-faint when">{formatDate(item.submitted_at)}</span>{/if}
              </li>
            {/each}
          </ul>
          {#if shown < results.length}
            <button type="button" class="xw7-button more" onclick={() => (shown += STEP)}>再显示 {Math.min(STEP, results.length - shown)} 份</button>
          {/if}
        {/if}
      </Card>
    </div>

    <div class="reader">
      {#if selected}
        <Card title={selected.title} subtitle={selected.path}>
          {#snippet actions()}
            <button type="button" class="xw7-button back" onclick={close}>← 列表</button>
            {#if safeUrl(selected.problem_url)}<a class="xw7-button" href={safeUrl(selected.problem_url)} target="_blank" rel="noopener noreferrer">题目</a>{/if}
            {#if githubUrl}<a class="xw7-button" href={githubUrl} target="_blank" rel="noopener noreferrer">GitHub</a>{/if}
            <button type="button" class="xw7-button" onclick={copy} disabled={!source}>{copied ? '已复制' : '复制'}</button>
          {/snippet}
          {#if loading}
            <Skeleton lines={12} />
          {:else if sourceError}
            <Notice tone="bad">源码加载失败：{sourceError}</Notice>
          {:else}
            <pre class="code"><code>{@html html}</code></pre>
          {/if}
        </Card>
      {:else}
        <Card tone="flat">
          <p class="empty">从左边选一份题解看源码</p>
        </Card>
      {/if}
    </div>
  </div>
{/if}

<style>
  .layout {
    display: grid;
    grid-template-columns: minmax(280px, 380px) minmax(0, 1fr);
    gap: var(--space-4);
    align-items: start;
  }

  .list {
    position: sticky;
    top: calc(var(--topbar-height) + var(--space-3));
    max-height: calc(100vh - var(--topbar-height) - var(--space-6));
    overflow-y: auto;
    border-radius: var(--radius-3);
  }

  .filters .xw7-input {
    flex: 1 1 180px;
  }

  .count {
    margin: var(--space-3) 0 var(--space-1);
    font-size: var(--text-xs);
  }

  li.active a {
    color: var(--accent-strong);
    font-weight: 600;
  }

  .when {
    flex: none;
    font-size: var(--text-xs);
  }

  .more {
    width: 100%;
    margin-top: var(--space-3);
  }

  .back {
    display: none;
  }

  .code {
    max-height: 75vh;
    margin: 0;
    padding: var(--space-4);
    overflow: auto;
    border-radius: var(--radius-2);
    background: var(--surface-2);
    font-family: var(--font-mono);
    font-size: 13px;
    line-height: 1.55;
    tab-size: 4;
  }

  .code :global(.tok-comment) {
    color: var(--text-3);
    font-style: italic;
  }

  .code :global(.tok-meta) {
    color: var(--series-4);
  }

  .code :global(.tok-string) {
    color: var(--series-3);
  }

  .code :global(.tok-number) {
    color: var(--series-5);
  }

  .code :global(.tok-keyword) {
    color: var(--accent-strong);
    font-weight: 600;
  }

  .code :global(.tok-type) {
    color: var(--series-2);
  }

  @media (max-width: 880px) {
    .layout {
      grid-template-columns: minmax(0, 1fr);
    }

    .list {
      position: static;
      max-height: none;
    }

    .layout.reading .list,
    .layout:not(.reading) .reader {
      display: none;
    }

    .back {
      display: inline-flex;
    }
  }
</style>
