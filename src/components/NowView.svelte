<script>
  import { onMount } from 'svelte';
  import Card from '@xw7/ui/components/Card.svelte';
  import Notice from '@xw7/ui/components/Notice.svelte';
  import Skeleton from '@xw7/ui/components/Skeleton.svelte';
  import { formatDate } from '@xw7/ui/format';
  import { getJson, poll, signedIn } from '../lib/api.js';
  import NowCard from './NowCard.svelte';

  let status = $state.raw(null);
  let error = $state('');
  let mine = $state(false);
  let now = $state(Date.now());

  onMount(() => {
    mine = signedIn();
    return poll(async () => {
      try {
        status = (await load()).data;
        error = '';
      } catch (reason) {
        error = reason.message;
      }
      now = Date.now();
    }, 30_000);
  });

  // 登录后读完整状态；会话过期就退回公开部分，不打断浏览。
  async function load() {
    if (mine) {
      try {
        return await getJson('/api/v1/me/now', { login: false });
      } catch (reason) {
        if (reason.status !== 401) throw reason;
        mine = false;
      }
    }
    return getJson('/api/v1/now');
  }
</script>

<div class="page-head">
  <div>
    <h1>此刻</h1>
    <p>Mac 上的 macflare 定时上报的状态，每 30 秒刷新一次。</p>
  </div>
</div>

{#if error && !status}
  <Notice tone="bad">状态暂时取不到：{error}</Notice>
{:else}
  <div class="grid grid-2">
    <Card title={mine ? '完整状态' : '公开状态'} subtitle={status?.collected_at ? `采集于 ${formatDate(status.collected_at, true)}` : ''}>
      {#if !status}<Skeleton lines={4} />{:else}<NowCard {status} {now} />{/if}
    </Card>
    <Card title="说明" tone="flat">
      <ul class="notes">
        <li>公开部分只有在不在线和正在听的歌。</li>
        <li>前台应用、运行中的应用、电量和负载只有登录后可见。</li>
        <li>超过几分钟没有收到上报就显示为离线。</li>
      </ul>
      {#if !mine}<p><a href="/login/?next=/now/">登录</a>后查看完整状态。</p>{/if}
    </Card>
  </div>
{/if}

<style>
  .notes {
    display: grid;
    gap: var(--space-2);
    margin: 0 0 var(--space-3);
    padding-left: 1.2em;
    color: var(--text-2);
  }
</style>
