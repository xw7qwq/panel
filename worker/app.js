import { api } from './api.js';
import { login, logout, readSession, safeNext } from './auth.js';
import { authorize } from './consent.js';
import { fail, ok, redirect, sameOrigin } from './http.js';
import { passkeyApi } from './passkey.js';

// 除 /mcp 和 OAuth 端点以外的请求都到这里：登录（口令和通行密钥）、同意页、/api/v1，以及需要登录的 /me/ 页面。
// 其余路径直接交给静态资源。
export const app = {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const path = url.pathname;
    if (path === '/authorize') return authorize(request, env);
    if (path === '/login' || path === '/login/') {
      if (request.method === 'POST') return login(request, env);
      // reauth=1：已登录也要重新验证一次（管理通行密钥前）。
      if (url.searchParams.get('reauth') !== '1' && (await readSession(request, env))) return redirect(safeNext(url.searchParams.get('next')));
      return env.ASSETS.fetch(request);
    }
    if (path === '/logout' || path === '/logout/') return logout(request);
    if (path === '/api/v1/me/grants') return grants(request, env);
    if (/^\/api\/v1\/(auth\/|me\/passkeys(\/|$))/.test(path)) return passkeyApi(request, env);
    if (path.startsWith('/api/')) return api(request, env, ctx);
    if (path === '/me' || path.startsWith('/me/')) {
      if (!(await readSession(request, env))) return redirect(`/login/?next=${encodeURIComponent(`${path}${url.search}`)}`);
      return privatePage(await env.ASSETS.fetch(request));
    }
    return env.ASSETS.fetch(request);
  },
};

// 登录后的页面外壳本身不含数据，但也不让任何缓存保存它。
function privatePage(response) {
  const headers = new Headers(response.headers);
  headers.set('Cache-Control', 'private, no-store');
  headers.set('X-Robots-Tag', 'noindex');
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}

// 已授权的 MCP 应用：列出和撤销。
async function grants(request, env) {
  if (!(await readSession(request, env))) return fail(401, 'unauthorized', '需要登录');
  const oauth = env.OAUTH_PROVIDER;
  if (!oauth) return fail(503, 'oauth_unavailable', 'OAuth 没有启用');
  if (request.method === 'GET') {
    const { items } = await oauth.listUserGrants('owner');
    return ok(
      items.map((grant) => ({
        id: grant.id,
        client: grant.metadata?.client || grant.clientId,
        scope: grant.scope,
        created_at: new Date(grant.createdAt * 1000).toISOString(),
        expires_at: grant.expiresAt ? new Date(grant.expiresAt * 1000).toISOString() : null,
      })),
    );
  }
  if (request.method === 'DELETE') {
    if (!sameOrigin(request)) return fail(403, 'cross_origin', '只接受本站发起的请求');
    const id = new URL(request.url).searchParams.get('id');
    if (!id || id.length > 200) return fail(400, 'invalid_id', '缺少授权 id');
    await oauth.revokeGrant(id, 'owner');
    return ok({ revoked: id });
  }
  return fail(405, 'method_not_allowed', '只支持 GET 和 DELETE', { headers: { Allow: 'GET, DELETE' } });
}
