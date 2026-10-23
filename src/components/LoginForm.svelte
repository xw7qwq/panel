<script>
  import { onMount } from 'svelte';
  import Card from '@xw7/ui/components/Card.svelte';
  import Notice from '@xw7/ui/components/Notice.svelte';

  const ERRORS = {
    wrong: '口令不对，再试一次。',
    rate: '试得太频繁了，过一分钟再来。',
  };

  let next = $state('/me/');
  let error = $state('');
  let busy = $state(false);

  onMount(() => {
    const params = new URL(location.href).searchParams;
    const value = params.get('next');
    if (value && value.startsWith('/') && !value.startsWith('//')) next = value;
    error = ERRORS[params.get('error')] ?? '';
  });
</script>

<div class="login">
  <Card title="登录" subtitle="只有面板的主人能登录。">
    {#if error}<div class="notice"><Notice tone="bad">{error}</Notice></div>{/if}
    <form method="post" action="/login/" onsubmit={() => (busy = true)}>
      <input type="hidden" name="next" value={next} />
      <input class="xw7-visually-hidden" type="text" name="username" value="owner" autocomplete="username" tabindex="-1" aria-hidden="true" readonly />
      <label for="passphrase">口令</label>
      <!-- svelte-ignore a11y_autofocus -->
      <input id="passphrase" class="xw7-input" name="passphrase" type="password" autocomplete="current-password" maxlength="1024" required autofocus />
      <button class="xw7-button xw7-button--primary" type="submit" disabled={busy}>{busy ? '正在登录…' : '登录'}</button>
    </form>
    <p class="xw7-faint hint">登录状态保存 30 天。公开内容不需要登录。</p>
  </Card>
</div>

<style>
  .login {
    max-width: 420px;
    margin: var(--space-7) auto;
  }

  .notice {
    margin-bottom: var(--space-4);
  }

  form {
    display: grid;
    gap: var(--space-2);
  }

  label {
    color: var(--text-2);
    font-size: var(--text-sm);
  }

  button {
    margin-top: var(--space-2);
  }

  .hint {
    margin-top: var(--space-4);
    font-size: var(--text-xs);
  }
</style>
