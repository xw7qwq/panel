import { readSession } from './auth.js';
import { escapeHtml, fail, html, redirect, sameOrigin } from './http.js';

// /authorize：MCP 客户端来要授权时，先确认是本人登录，再显示同意页。
// 授权请求本身由 OAuthProvider 校验和保存，表单里只带一次性的 handle。
export const SCOPE = 'panel:read';

const isAuthorizationError = (error) => error?.name === 'AuthorizationError';
const isCimdError = (error) => error?.name === 'CimdFetchError';

export async function authorize(request, env) {
  const oauth = env.OAUTH_PROVIDER;
  try {
    if (request.method === 'GET') return await showConsent(request, env, oauth);
    if (request.method === 'POST') return await answerConsent(request, env, oauth);
    return fail(405, 'method_not_allowed', '只支持 GET 和 POST', { headers: { Allow: 'GET, POST' } });
  } catch (error) {
    if (isAuthorizationError(error) && error.redirectTo) return redirect(error.redirectTo);
    if (isAuthorizationError(error)) return page('授权没有完成', `<p>${escapeHtml(error.description || error.message)}</p><p>回到应用里重新发起连接即可。</p>`, 400);
    if (isCimdError(error)) return page('无法确认这个应用', '<p>读取应用的元数据失败，请稍后在应用里重试。</p>', 400);
    throw error;
  }
}

async function showConsent(request, env, oauth) {
  const authRequest = await oauth.parseAuthRequest(request);
  if (!(await readSession(request, env))) {
    const url = new URL(request.url);
    return redirect(`/login/?next=${encodeURIComponent(`${url.pathname}${url.search}`)}`);
  }
  const details = await oauth.describeConsent(authRequest);
  const consent = await oauth.beginConsent(authRequest);
  const body = consentBody(details, consent.handle);
  const response = page(`授权 ${details.clientName}`, body);
  for (const [name, value] of consent.headers) {
    if (name.toLowerCase() === 'set-cookie') response.headers.append(name, value);
    else response.headers.set(name, value);
  }
  return response;
}

async function answerConsent(request, env, oauth) {
  if (!sameOrigin(request)) return fail(403, 'cross_origin', '只接受本站表单提交');
  if (!(await readSession(request, env))) return page('需要登录', '<p>登录状态已失效，请回到应用里重新发起连接。</p>', 401);
  const form = await request.formData();
  const handle = String(form.get('handle') || '');
  if (form.get('decision') !== 'approve') {
    const denied = await oauth.denyConsent(request, handle);
    return new Response(null, { status: 302, headers: denied.headers });
  }
  const approved = await oauth.approveConsent(request, handle, { scope: [SCOPE] });
  // 应用名记在授权里，方便在「我的」页面列出和撤销。
  const client = await oauth.lookupClient(approved.request.clientId).catch(() => null);
  const { redirectTo } = await oauth.completeAuthorization({
    request: approved.request,
    userId: 'owner',
    metadata: { client: client?.clientName || approved.request.clientId, approved_at: new Date().toISOString() },
    scope: approved.request.scope,
    props: { user: 'owner' },
  });
  approved.headers.set('Location', redirectTo);
  approved.headers.set('Cache-Control', 'no-store');
  return new Response(null, { status: 302, headers: approved.headers });
}

export function consentBody(details, handle) {
  const name = escapeHtml(details.clientName);
  const origin = details.clientDomain
    ? `<p class="meta">发布方：<strong>${escapeHtml(details.clientDomain)}</strong></p>`
    : '<p class="meta">这个应用是自行注册的，名字没有经过验证。</p>';
  const loopback = details.redirectIsLoopback
    ? '<p class="warn">授权会交给你电脑上的一个本地程序。只有在你刚刚从那个程序发起连接时才继续。</p>'
    : '';
  return `
    <h1>允许 ${name} 读取面板数据？</h1>
    ${origin}
    <p>授权会发送到 <strong>${escapeHtml(details.redirectHost)}</strong>。</p>
    ${loopback}
    <ul class="scope">
      <li>刷题统计、题解源码、Mac 当前状态</li>
      <li>健康指标和趋势</li>
      <li>记账：余额、按月收支、近期交易</li>
    </ul>
    <p class="meta">只读，不能修改任何数据。授权 30 天有效，可以在「我的」页面随时撤销。</p>
    <form method="post">
      <input type="hidden" name="handle" value="${escapeHtml(handle)}">
      <div class="actions">
        <button class="primary" name="decision" value="approve">允许</button>
        <button name="decision" value="deny">拒绝</button>
      </div>
    </form>`;
}

// 和面板同一套配色的极简页面；同意页不能被嵌入别的网站。
export function page(title, body, status = 200) {
  return html(
    `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>${escapeHtml(title)} · xw7</title>
<style>
:root{color-scheme:light dark;--bg:#fbf6f9;--surface:#fff;--border:#ecdde6;--text:#1d1419;--text-2:#5f4d58;--accent:#a84a76;--accent-ink:#fff;--warn-soft:#fbefd9;--warn:#a8660f}
@media (prefers-color-scheme:dark){:root{--bg:#0d0b10;--surface:#151118;--border:#2e2534;--text:#f7ecf2;--text-2:#c7b2bf;--accent:#e7a3c3;--accent-ink:#1a0f16;--warn-soft:#332611;--warn:#e3a64a}}
*{box-sizing:border-box}
body{margin:0;min-height:100vh;display:grid;place-items:center;padding:24px 16px;background:var(--bg);color:var(--text);font:16px/1.6 -apple-system,BlinkMacSystemFont,"Segoe UI","PingFang SC","Noto Sans SC","Microsoft YaHei",sans-serif}
main{width:min(100%,440px);padding:28px;border:1px solid var(--border);border-radius:16px;background:var(--surface)}
.brand{margin:0 0 18px;color:var(--accent);font-weight:700;letter-spacing:.02em}
h1{margin:0 0 12px;font-size:1.25rem;line-height:1.35}
p{margin:0 0 10px}
.meta{color:var(--text-2);font-size:.9rem}
.warn{padding:10px 12px;border-radius:10px;background:var(--warn-soft);color:var(--text);font-size:.9rem}
.scope{margin:14px 0;padding-left:1.2em;color:var(--text-2)}
.actions{display:flex;gap:10px;margin-top:18px}
button{flex:1;padding:10px 14px;border:1px solid var(--border);border-radius:999px;background:var(--surface);color:var(--text);font:inherit;font-weight:600;cursor:pointer}
button.primary{border-color:var(--accent);background:var(--accent);color:var(--accent-ink)}
button:focus-visible{outline:3px solid color-mix(in srgb,var(--accent) 40%,transparent);outline-offset:2px}
</style>
</head>
<body><main><p class="brand">xw7 面板</p>${body}</main></body>
</html>`,
    { status },
  );
}
