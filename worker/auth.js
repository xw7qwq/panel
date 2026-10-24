import { HttpError, clientIp, fail, readBody, redirect, sameOrigin } from './http.js';

// 登录用口令（Worker secret OWNER_PASSPHRASE）或通行密钥（passkey.js）。两种方式都发同一张 HMAC 签名的会话 Cookie，30 天有效；
// 换掉 SESSION_SECRET 会让所有设备上的登录立即失效。另有一个不带 HttpOnly 的提示 Cookie，只给界面判断显示什么。
// 删掉 OWNER_PASSPHRASE 就只能用通行密钥登录。
export const SESSION_COOKIE = '__Host-xw7_session';
export const HINT_COOKIE = 'xw7_signed_in';
export const SESSION_SECONDS = 30 * 86400;

const encoder = new TextEncoder();

export function base64url(bytes) {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function fromBase64url(text) {
  const binary = atob(text.replace(/-/g, '+').replace(/_/g, '/'));
  return Uint8Array.from(binary, (char) => char.charCodeAt(0));
}

function hmacKey(secret) {
  return crypto.subtle.importKey('raw', encoder.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign', 'verify']);
}

export async function signValue(secret, value) {
  const signature = await crypto.subtle.sign('HMAC', await hmacKey(secret), encoder.encode(value));
  return base64url(new Uint8Array(signature));
}

export async function verifyValue(secret, value, signature) {
  try {
    return await crypto.subtle.verify('HMAC', await hmacKey(secret), fromBase64url(signature), encoder.encode(value));
  } catch {
    return false;
  }
}

export async function createSessionToken(secret, now = Date.now()) {
  const issued = Math.floor(now / 1000);
  const payload = base64url(encoder.encode(JSON.stringify({ sub: 'owner', iat: issued, exp: issued + SESSION_SECONDS })));
  return `${payload}.${await signValue(secret, payload)}`;
}

export async function verifySessionToken(secret, token, now = Date.now()) {
  if (!secret || typeof token !== 'string') return null;
  const [payload, signature, extra] = token.split('.');
  if (!payload || !signature || extra !== undefined) return null;
  if (!(await verifyValue(secret, payload, signature))) return null;
  try {
    const session = JSON.parse(new TextDecoder().decode(fromBase64url(payload)));
    if (session.sub !== 'owner' || !Number.isFinite(session.exp) || session.exp * 1000 <= now) return null;
    return session;
  } catch {
    return null;
  }
}

export function readCookie(request, name) {
  const header = request.headers.get('Cookie') || '';
  for (const part of header.split(';')) {
    const index = part.indexOf('=');
    if (index > 0 && part.slice(0, index).trim() === name) return part.slice(index + 1).trim();
  }
  return null;
}

export function readSession(request, env, now = Date.now()) {
  return verifySessionToken(env.SESSION_SECRET, readCookie(request, SESSION_COOKIE), now);
}

// 比较两个口令的 SHA-256，长度固定，逐字节异或，避免按位置提前返回。
export async function passphraseMatches(expected, input) {
  if (typeof expected !== 'string' || !expected || typeof input !== 'string' || !input || input.length > 1024) return false;
  const [a, b] = await Promise.all([expected, input].map((value) => crypto.subtle.digest('SHA-256', encoder.encode(value))));
  const left = new Uint8Array(a);
  const right = new Uint8Array(b);
  let difference = 0;
  for (let i = 0; i < left.length; i++) difference |= left[i] ^ right[i];
  return difference === 0;
}

export function sessionCookies(token) {
  return [
    `${SESSION_COOKIE}=${token}; Path=/; Max-Age=${SESSION_SECONDS}; HttpOnly; Secure; SameSite=Lax`,
    `${HINT_COOKIE}=1; Path=/; Max-Age=${SESSION_SECONDS}; Secure; SameSite=Lax`,
  ];
}

export function clearedCookies() {
  return [`${SESSION_COOKIE}=; Path=/; Max-Age=0; HttpOnly; Secure; SameSite=Lax`, `${HINT_COOKIE}=; Path=/; Max-Age=0; Secure; SameSite=Lax`];
}

// 登录后只跳回本站路径，防止被拿来做开放跳转。
export function safeNext(value, fallback = '/me/') {
  if (typeof value !== 'string' || !value.startsWith('/') || value.startsWith('//') || value.includes('\\')) return fallback;
  try {
    const url = new URL(value, 'https://panel.invalid');
    return url.origin === 'https://panel.invalid' ? `${url.pathname}${url.search}` : fallback;
  } catch {
    return fallback;
  }
}

function loginRedirect(error, next) {
  return redirect(`/login/?error=${error}&next=${encodeURIComponent(next)}`, 303);
}

export async function login(request, env) {
  if (!sameOrigin(request)) return fail(403, 'cross_origin', '只接受本站表单提交的登录');
  if (!env.SESSION_SECRET) return fail(503, 'auth_not_configured', '登录还没有配置');
  let body;
  try {
    body = await readBody(request, 4096);
  } catch (error) {
    if (error instanceof HttpError) return fail(error.status, error.code, error.message);
    throw error;
  }
  const next = safeNext(body.next);
  if (!env.OWNER_PASSPHRASE) return loginRedirect('disabled', next);
  if (env.LOGIN_LIMITER) {
    const { success } = await env.LOGIN_LIMITER.limit({ key: `login:${clientIp(request)}` });
    if (!success) return loginRedirect('rate', next);
  }
  if (!(await passphraseMatches(env.OWNER_PASSPHRASE, body.passphrase))) {
    // 失败后稍等再回应，放慢逐个尝试的速度。
    await new Promise((resolve) => setTimeout(resolve, 600));
    return loginRedirect('wrong', next);
  }
  const headers = new Headers({ Location: next, 'Cache-Control': 'no-store' });
  for (const cookie of sessionCookies(await createSessionToken(env.SESSION_SECRET))) headers.append('Set-Cookie', cookie);
  return new Response(null, { status: 303, headers });
}

export function logout(request) {
  if (request.method !== 'POST') return fail(405, 'method_not_allowed', '退出登录请用 POST', { headers: { Allow: 'POST' } });
  if (!sameOrigin(request)) return fail(403, 'cross_origin', '只接受本站发起的退出');
  const headers = new Headers({ Location: '/', 'Cache-Control': 'no-store' });
  for (const cookie of clearedCookies()) headers.append('Set-Cookie', cookie);
  return new Response(null, { status: 303, headers });
}
