<script>
  import { onMount } from 'svelte';
  import Card from '@xw7/ui/components/Card.svelte';
  import Notice from '@xw7/ui/components/Notice.svelte';
  import { ApiError, getJson } from '../lib/api.js';
  import { autofillSupported, cancelPasskey, passkeyError, passkeyLoginOptions, passkeySupported, signInWithPasskey } from '../lib/passkey.js';

  const ERRORS = {
    wrong: '口令不对，再试一次。',
    rate: '试得太频繁了，过一分钟再来。',
    disabled: '口令登录已关闭，请用通行密钥登录。',
  };

  let next = $state('/me/');
  let error = $state('');
  let busy = $state(false);
  let reauth = $state(false);
  // 静态页面先按只有口令来渲染，读到服务端的配置后再调整。
  let methods = $state({ passphrase: true, passkey: false });
  let supported = $state(true);
  let passkeyBusy = $state(false);
  let autofill = false;
  let pendingOptions = null;

  onMount(() => {
    const params = new URL(location.href).searchParams;
    const value = params.get('next');
    if (value && value.startsWith('/') && !value.startsWith('//')) next = value;
    error = ERRORS[params.get('error')] ?? '';
    reauth = params.get('reauth') === '1';
    supported = passkeySupported();
    getJson('/api/v1/auth/methods', { login: false }).then(
      async (body) => {
        methods = body.data;
        autofill = methods.passkey && methods.passphrase && (await autofillSupported());
        if (autofill) arm();
      },
      () => {},
    );
    return cancelPasskey;
  });

  // 自动填充：口令框的下拉里会出现通行密钥，选了就直接登录。
  async function arm() {
    const started = Date.now();
    pendingOptions = passkeyLoginOptions();
    let options;
    try {
      options = await pendingOptions;
    } catch {
      return;
    } finally {
      pendingOptions = null;
    }
    if (passkeyBusy) return;
    try {
      location.assign(await signInWithPasskey(options, { next, autofill: true }));
    } catch (reason) {
      const message = passkeyError(reason);
      if (!message) return;
      if (reason instanceof ApiError) error = message;
      // challenge 过期、取消或选错了都重新挂上；刚挂上就失败的不再重试，免得空转。
      if (Date.now() - started > 5000 && !passkeyBusy) arm();
    }
  }

  async function usePasskey() {
    passkeyBusy = true;
    error = '';
    try {
      // 等自动填充那边的 challenge 先发下来，免得两个请求的 Cookie 互相覆盖。
      await pendingOptions?.catch(() => {});
      location.assign(await signInWithPasskey(await passkeyLoginOptions(), { next }));
    } catch (reason) {
      error = passkeyError(reason);
      passkeyBusy = false;
      if (autofill) arm();
    }
  }
</script>

<div class="login">
  <Card title={reauth ? '重新验证' : '登录'} subtitle={reauth ? '添加或删除通行密钥前，需要再确认一次是你本人。' : '只有面板的主人能登录。'}>
    {#if error}<div class="notice"><Notice tone="bad">{error}</Notice></div>{/if}
    {#if methods.passkey}
      <button class="xw7-button xw7-button--primary wide" type="button" onclick={usePasskey} disabled={passkeyBusy || !supported}>
        {passkeyBusy ? '等待通行密钥…' : '使用通行密钥登录'}
      </button>
      {#if !supported}<p class="xw7-faint hint">这个浏览器不支持通行密钥，请换一个浏览器或用口令登录。</p>{/if}
    {/if}
    {#if methods.passkey && methods.passphrase}<p class="divider xw7-faint">或者用口令</p>{/if}
    {#if methods.passphrase}
      <form method="post" action="/login/" onsubmit={() => (busy = true)}>
        <input type="hidden" name="next" value={next} />
        <input class="xw7-visually-hidden" type="text" name="username" value="owner" autocomplete="username" tabindex="-1" aria-hidden="true" readonly />
        <label for="passphrase">口令</label>
        <!-- svelte-ignore a11y_autofocus -->
        <input id="passphrase" class="xw7-input" name="passphrase" type="password" autocomplete="current-password webauthn" maxlength="1024" required autofocus />
        <button class={['xw7-button', !methods.passkey && 'xw7-button--primary']} type="submit" disabled={busy}>{busy ? '正在登录…' : '登录'}</button>
      </form>
    {:else if !methods.passkey}
      <p class="xw7-muted">登录还没有配置。</p>
    {/if}
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

  .wide {
    justify-content: center;
    width: 100%;
  }

  .divider {
    display: flex;
    align-items: center;
    gap: var(--space-3);
    margin: var(--space-4) 0 var(--space-2);
  }

  .divider::before,
  .divider::after {
    flex: 1;
    height: 1px;
    background: var(--border);
    content: '';
  }

  form {
    display: grid;
    gap: var(--space-2);
  }

  label {
    color: var(--text-2);
    font-size: var(--text-sm);
  }

  form button {
    justify-content: center;
    margin-top: var(--space-2);
  }

  .hint {
    margin-top: var(--space-4);
    font-size: var(--text-xs);
  }
</style>
