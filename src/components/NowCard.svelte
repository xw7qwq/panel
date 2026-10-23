<script>
  import { formatNumber, relativeTime } from '@xw7/ui/format';
  import { safeUrl } from '../lib/api.js';

  // Mac 此刻的状态。公开接口只有在线与否和正在听的歌；登录后多出前台应用、电量和负载。
  let { status = null, now = Date.now(), compact = false } = $props();

  const STATES = { playing: '正在播放', paused: '已暂停' };
  const online = $derived(status?.status === 'online');
  const music = $derived(online ? (status.music ?? null) : null);
  const hasTrack = $derived(Boolean(music?.track) && music.state in STATES);
  const app = $derived(typeof status?.active_app === 'string' ? status.active_app : (status?.active_app?.name ?? null));
  const apps = $derived(
    Array.isArray(status?.running_apps)
      ? status.running_apps.map((item) => (typeof item === 'string' ? item : item?.name)).filter(Boolean)
      : [],
  );
  const battery = $derived(status?.battery?.percent ?? null);
  const load = $derived(status?.system?.load_1m ?? null);
</script>

<div class="now" class:compact>
  <div class="presence">
    <span class="dot" class:online aria-hidden="true"></span>
    <strong>{online ? 'Mac 在线' : 'Mac 离线'}</strong>
    {#if online && status.updated_at}<span class="xw7-muted">· {relativeTime(status.updated_at, now)}更新</span>{/if}
  </div>

  {#if online}
    <div class="music">
      {#if hasTrack && safeUrl(music.artwork_url)}
        <img src={safeUrl(music.artwork_url)} alt="" width="56" height="56" loading="lazy" referrerpolicy="no-referrer" />
      {:else}
        <span class="art" aria-hidden="true">♪</span>
      {/if}
      <div class="grow">
        {#if hasTrack}
          <div class="xw7-muted small">{STATES[music.state]}</div>
          {#if safeUrl(music.track_url)}
            <a class="track ellipsis" href={safeUrl(music.track_url)} target="_blank" rel="noopener noreferrer">{music.track}</a>
          {:else}
            <div class="track ellipsis">{music.track}</div>
          {/if}
          <div class="xw7-muted ellipsis">{music.artist || '未知歌手'}</div>
        {:else}
          <div class="track">没有在放歌</div>
          <div class="xw7-muted small">安静地做事中</div>
        {/if}
      </div>
    </div>

    {#if !compact && (app || battery !== null || load !== null)}
      <dl class="facts">
        {#if app}<div><dt>前台应用</dt><dd>{app}</dd></div>{/if}
        {#if battery !== null}<div><dt>电量</dt><dd class="xw7-num">{battery}%{status.battery.charging ? ' · 充电中' : ''}</dd></div>{/if}
        {#if load !== null}
          <div><dt>负载</dt><dd class="xw7-num">{formatNumber(load, 1)} / {formatNumber(status.system.load_5m, 1)} / {formatNumber(status.system.load_15m, 1)}</dd></div>
        {/if}
      </dl>
    {/if}
    {#if !compact && apps.length}
      <div class="apps" aria-label="正在运行的应用">
        {#each apps as name, index (index)}<span class="badge">{name}</span>{/each}
      </div>
    {/if}
  {:else if status}
    <p class="xw7-muted">最近没有收到 Mac 的状态，可能合上了盖子或者没联网。</p>
  {:else}
    <p class="xw7-muted">状态暂时取不到。</p>
  {/if}
</div>

<style>
  .now {
    display: grid;
    gap: var(--space-4);
  }

  .presence {
    display: flex;
    align-items: center;
    gap: var(--space-2);
  }

  .dot {
    width: 10px;
    height: 10px;
    border-radius: 50%;
    background: var(--text-3);
  }

  .dot.online {
    background: var(--good);
    box-shadow: 0 0 0 4px var(--good-soft);
  }

  .music {
    display: flex;
    align-items: center;
    gap: var(--space-3);
    min-width: 0;
  }

  img,
  .art {
    flex: none;
    width: 56px;
    height: 56px;
    border-radius: var(--radius-2);
    object-fit: cover;
  }

  .art {
    display: grid;
    place-items: center;
    background: var(--accent-soft);
    color: var(--accent-strong);
    font-size: var(--text-xl);
  }

  .track {
    display: block;
    color: var(--text);
    font-weight: 600;
  }

  .small {
    font-size: var(--text-xs);
  }

  .facts {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(130px, 1fr));
    gap: var(--space-3);
    margin: 0;
  }

  .facts dt {
    color: var(--text-3);
    font-size: var(--text-xs);
  }

  .facts dd {
    margin: 2px 0 0;
    font-weight: 600;
  }

  .apps {
    display: flex;
    flex-wrap: wrap;
    gap: 6px;
  }
</style>
