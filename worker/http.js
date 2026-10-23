// 响应工具。所有 JSON 接口都用同一个外形：成功 { data, updated_at, source }，失败 { error: { code, message } }。
export const JSON_TYPE = 'application/json; charset=utf-8';

export function json(body, init = {}) {
  const headers = new Headers(init.headers);
  headers.set('Content-Type', JSON_TYPE);
  if (!headers.has('Cache-Control')) headers.set('Cache-Control', 'no-store');
  headers.set('X-Content-Type-Options', 'nosniff');
  return new Response(JSON.stringify(body), { status: init.status ?? 200, headers });
}

// cache：公开数据的浏览器缓存秒数；0 表示不缓存。
export function ok(data, { updatedAt = null, source = null, cache = 0, cors = false, status = 200, headers } = {}) {
  const response = json(
    { data, updated_at: updatedAt, source },
    { status, headers: { 'Cache-Control': cacheControl(cache), ...headers } },
  );
  return cors ? withCors(response) : response;
}

export function fail(status, code, message, { cors = false, headers } = {}) {
  const response = json({ error: { code, message } }, { status, headers });
  return cors ? withCors(response) : response;
}

export function cacheControl(seconds) {
  return seconds > 0 ? `public, max-age=${seconds}, stale-while-revalidate=${seconds * 4}` : 'no-store';
}

// 公开只读接口允许任意来源读取；私有接口从不加 CORS 头。
export function withCors(response) {
  const headers = new Headers(response.headers);
  headers.set('Access-Control-Allow-Origin', '*');
  headers.set('Access-Control-Allow-Methods', 'GET, HEAD, OPTIONS');
  headers.set('Access-Control-Max-Age', '86400');
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}

export function preflight() {
  return withCors(new Response(null, { status: 204 }));
}

export function redirect(location, status = 302, headers = {}) {
  return new Response(null, { status, headers: { Location: location, 'Cache-Control': 'no-store', ...headers } });
}

export function html(body, { status = 200, headers } = {}) {
  return new Response(body, {
    status,
    headers: {
      'Content-Type': 'text/html; charset=utf-8',
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
      'X-Frame-Options': 'DENY',
      'Referrer-Policy': 'same-origin',
      ...headers,
    },
  });
}

export function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, (char) => `&#${char.charCodeAt(0)};`);
}

// 表单或 JSON 请求体都能读；体积超过上限直接拒绝。
export async function readBody(request, limit = 64 * 1024) {
  const length = Number(request.headers.get('Content-Length') || 0);
  if (length > limit) throw new HttpError(413, 'payload_too_large', '请求体太大');
  const type = request.headers.get('Content-Type') || '';
  const text = await request.text();
  if (text.length > limit) throw new HttpError(413, 'payload_too_large', '请求体太大');
  if (type.includes('application/json')) {
    try {
      return JSON.parse(text || '{}');
    } catch {
      throw new HttpError(400, 'invalid_json', '请求体不是合法的 JSON');
    }
  }
  return Object.fromEntries(new URLSearchParams(text));
}

export class HttpError extends Error {
  constructor(status, code, message) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

// 同源检查：浏览器发出的写请求必须来自本站。没有 Origin 的非浏览器请求不受影响。
export function sameOrigin(request) {
  const origin = request.headers.get('Origin');
  if (!origin) return request.headers.get('Sec-Fetch-Site') !== 'cross-site';
  return origin === new URL(request.url).origin;
}

// 面板只用一个正式地址（SITE_ORIGIN），OAuth 的签发方和资源地址都依赖它；其他域名一律跳过去。
// 本机调试和 workers.dev 预览不跳。
export function canonicalRedirect(request, siteOrigin) {
  if (!siteOrigin) return null;
  const url = new URL(request.url);
  if (url.origin === siteOrigin || ['localhost', '127.0.0.1'].includes(url.hostname) || url.hostname.endsWith('.workers.dev')) return null;
  return new Response(null, { status: 301, headers: { Location: `${siteOrigin}${url.pathname}${url.search}`, 'Cache-Control': 'public, max-age=3600' } });
}

export function clientIp(request) {
  return request.headers.get('CF-Connecting-IP') || 'unknown';
}
