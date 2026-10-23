<script>
  // 栏目内的子页面切换，例如刷题的「统计 / 题解」。
  let { items = [], current = '', label = '子页面' } = $props();
</script>

<nav class="subnav" aria-label={label}>
  {#each items as item (item.href)}
    <a href={item.href} aria-current={item.id === current ? 'page' : undefined}>{item.label}</a>
  {/each}
</nav>

<style>
  .subnav {
    display: inline-flex;
    gap: 2px;
    padding: 3px;
    border: 1px solid var(--border);
    border-radius: var(--radius-pill);
    background: var(--surface-2);
  }

  a {
    padding: 0.2rem 0.85rem;
    border-radius: var(--radius-pill);
    color: var(--text-2);
    font-size: var(--text-sm);
    text-decoration: none;
  }

  a:hover {
    color: var(--text);
  }

  a[aria-current='page'] {
    background: var(--surface);
    color: var(--text);
    box-shadow: var(--shadow-1);
  }
</style>
