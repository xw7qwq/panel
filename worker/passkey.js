import { base64url, createSessionToken, fromBase64url, readCookie, readSession, safeNext, sessionCookies, signValue, verifyValue } from './auth.js';
import { HttpError, clientIp, fail, ok, readBody, sameOrigin } from './http.js';
import { authenticationOptions, newChallenge, registrationOptions, verifyAuthentication, verifyRegistration } from './webauthn.js';

// 通行密钥（WebAuthn）登录。登录成功后发的还是口令登录那张会话 Cookie，所以 /me/ 和 MCP 授权都不用区分登录方式。
// 凭据只存公钥，放在 PANEL_KV 的一个键里；一次性的 challenge 放在签名的短期 Cookie 里，公开接口不写 KV。
// 按规范逐项校验的部分在 webauthn.js。
// rpID 默认取 PASSKEY_RP_ID（lucius7.dev），这样在 panel.lucius7.dev 登记的通行密钥切到主域名后照样能用。
export const STORE_KEY = 'auth:passkeys';
export const CHALLENGE_COOKIE = '__Host-xw7_passkey';
const CHALLENGE_SECONDS = 300;
// 添加或删除通行密钥要求最近 15 分钟内登录过：偷到旧会话 Cookie 的人不能借此留下自己的通行密钥。
export const FRESH_SECONDS = 15 * 60;
const MAX_PASSKEYS = 20;
const USER_ID = new TextEncoder().encode('xw7-owner');
const encoder = new TextEncoder();

// 常见密码管理器的 AAGUID，只用来给通行密钥起个默认名字。
const PROVIDERS = {
  'fbfc3007-154e-4ecc-8c0b-6e020557d7bd': 'iCloud 钥匙串',
  'ea9b8d66-4d01-1d21-3ce4-b6b48cb575d4': 'Google 密码管理器',
  'bada5566-a7aa-401f-bd96-45619a55120d': '1Password',
  'adce0002-35bc-c60a-648b-0b25f1f05503': 'Mac 上的 Chrome',
  'd548826e-79b4-db40-a3d8-11116f7e8349': 'Bitwarden',
  '08987058-cadc-4b81-b6e1-30de50dcbe96': 'Windows Hello',
  '9ddd1817-af5a-4672-a2b9-3e3dd95000a9': 'Windows Hello',
  '6028b017-b1d4-4c02-b4b3-afcdafc96bb2': 'Windows Hello',
};

export function relyingParty(env) {
  if (!env.SITE_ORIGIN || !env.SESSION_SECRET || !env.PANEL_KV) return null;
  return { origin: env.SITE_ORIGIN, rpID: env.PASSKEY_RP_ID || new URL(env.SITE_ORIGIN).hostname };
}

export async function loadPasskeys(env) {
  const list = await env.PANEL_KV.get(STORE_KEY, 'json');
  return Array.isArray(list) ? list : [];
}

function savePasskeys(env, list) {
  return env.PANEL_KV.put(STORE_KEY, JSON.stringify(list));
}

// owner：登记用的 challenge 记下要它的那个会话（签发时间），只有同一张会话 Cookie 能拿去登记。
async function challengeCookie(env, purpose, challenge, now = Date.now(), owner = null) {
  const payload = base64url(encoder.encode(JSON.stringify({ p: purpose, c: challenge, s: owner, exp: Math.floor(now / 1000) + CHALLENGE_SECONDS })));
  // 加前缀做区分，会话令牌的签名不能拿来冒充 challenge，反过来也一样。
  const signature = await signValue(env.SESSION_SECRET, `passkey.${payload}`);
  return `${CHALLENGE_COOKIE}=${payload}.${signature}; Path=/; Max-Age=${CHALLENGE_SECONDS}; HttpOnly; Secure; SameSite=Strict`;
}

export async function readChallenge(request, env, purpose, now = Date.now(), owner = null) {
  const value = readCookie(request, CHALLENGE_COOKIE);
  if (!value || !env.SESSION_SECRET) return null;
  const [payload, signature, extra] = value.split('.');
  if (!payload || !signature || extra !== undefined) return null;
  if (!(await verifyValue(env.SESSION_SECRET, `passkey.${payload}`, signature))) return null;
  try {
    const data = JSON.parse(new TextDecoder().decode(fromBase64url(payload)));
    if (data.p !== purpose || data.s !== owner || typeof data.c !== 'string' || !(data.exp * 1000 > now)) return null;
    return data.c;
  } catch {
    return null;
  }
}

const CLEAR_CHALLENGE = `${CHALLENGE_COOKIE}=; Path=/; Max-Age=0; HttpOnly; Secure; SameSite=Strict`;

function withCookies(response, cookies) {
  for (const cookie of cookies) response.headers.append('Set-Cookie', cookie);
  return response;
}

// 只给界面看的字段，不含公钥。
function describe(item) {
  return {
    id: item.id,
    name: item.name,
    provider: PROVIDERS[item.aaguid] ?? null,
    synced: Boolean(item.backed_up),
    created_at: item.created_at,
    last_used_at: item.last_used_at ?? null,
  };
}

async function body(request, limit) {
  try {
    return { value: await readBody(request, limit) };
  } catch (error) {
    if (error instanceof HttpError) return { error: fail(error.status, error.code, error.message) };
    throw error;
  }
}

// /api/v1/auth/*：登录页用，不需要会话。/api/v1/me/passkeys*：登录后管理通行密钥。
export async function passkeyApi(request, env, now = Date.now()) {
  const path = new URL(request.url).pathname.replace(/\/+$/, '');
  const known = ['/api/v1/auth/methods', '/api/v1/auth/passkey/options', '/api/v1/auth/passkey/verify', '/api/v1/me/passkeys', '/api/v1/me/passkeys/options'];
  if (!known.includes(path)) return fail(404, 'not_found', '没有这个接口');
  const rp = relyingParty(env);
  if (path === '/api/v1/auth/methods') {
    if (request.method !== 'GET') return fail(405, 'method_not_allowed', '只支持 GET', { headers: { Allow: 'GET' } });
    const passkeys = rp ? (await loadPasskeys(env)).length : 0;
    return ok({ passphrase: Boolean(env.OWNER_PASSPHRASE && env.SESSION_SECRET), passkey: passkeys > 0 });
  }
  if (!rp) return fail(503, 'auth_not_configured', '通行密钥还没有配置');
  if (path === '/api/v1/auth/passkey/options') return post(request, () => loginOptions(env, rp, now));
  if (path === '/api/v1/auth/passkey/verify') return post(request, () => loginVerify(request, env, rp, now));

  const session = await readSession(request, env, now);
  if (!session) return fail(401, 'unauthorized', '需要登录');
  const fresh = now - session.iat * 1000 <= FRESH_SECONDS * 1000;
  if (path === '/api/v1/me/passkeys/options') return post(request, () => (fresh ? registerOptions(env, rp, session, now) : reauth()));
  if (request.method === 'GET') return list(env, rp, fresh);
  if (request.method !== 'POST' && request.method !== 'DELETE') {
    return fail(405, 'method_not_allowed', '只支持 GET、POST 和 DELETE', { headers: { Allow: 'GET, POST, DELETE' } });
  }
  if (!sameOrigin(request)) return fail(403, 'cross_origin', '只接受本站发起的请求');
  // 登记只认 challenge Cookie：它只发给刚验证过的会话、绑定这个会话，5 分钟后失效，所以这里不再查会话新不新。
  if (request.method === 'POST') return register(request, env, rp, session, now);
  return fresh ? remove(request, env) : reauth();
}

function post(request, handler) {
  if (request.method !== 'POST') return fail(405, 'method_not_allowed', '只支持 POST', { headers: { Allow: 'POST' } });
  if (!sameOrigin(request)) return fail(403, 'cross_origin', '只接受本站发起的请求');
  return handler();
}

function reauth() {
  return fail(403, 'reauth_required', '为了安全，添加或删除通行密钥前需要重新验证一次');
}

async function loginOptions(env, rp, now) {
  const options = authenticationOptions({ challenge: newChallenge(), rpID: rp.rpID, timeout: CHALLENGE_SECONDS * 1000 });
  return withCookies(ok(options), [await challengeCookie(env, 'login', options.challenge, now)]);
}

async function loginVerify(request, env, rp, now) {
  const parsed = await body(request, 16 * 1024);
  if (parsed.error) return parsed.error;
  const { response, next } = parsed.value;
  if (env.LOGIN_LIMITER) {
    const { success } = await env.LOGIN_LIMITER.limit({ key: `login:${clientIp(request)}` });
    if (!success) return fail(429, 'rate_limited', '试得太频繁了，过一分钟再来');
  }
  const challenge = await readChallenge(request, env, 'login', now);
  if (!challenge) return fail(400, 'challenge_expired', '登录请求过期了，请再试一次');
  const passkeys = await loadPasskeys(env);
  const item = passkeys.find((entry) => entry.id === response?.id);
  if (!item) return fail(400, 'unknown_passkey', '这把通行密钥没有登记，或者已经删除了');
  // 同一个 challenge 只能用一次：上次成功登录用过的 challenge 再来就是重放。
  if (item.last_challenge === challenge) return fail(400, 'passkey_failed', '通行密钥验证失败');
  let result;
  try {
    result = await verifyAuthentication(response, item, { challenge, origin: rp.origin, rpID: rp.rpID });
  } catch (error) {
    console.warn(`passkey login rejected: ${error.message}`);
    return fail(400, 'passkey_failed', '通行密钥验证失败');
  }
  Object.assign(item, {
    counter: result.counter,
    backed_up: result.backedUp,
    last_used_at: new Date(now).toISOString(),
    last_challenge: challenge,
  });
  await savePasskeys(env, passkeys);
  const target = safeNext(next);
  return withCookies(ok({ next: target }), [...sessionCookies(await createSessionToken(env.SESSION_SECRET, now)), CLEAR_CHALLENGE]);
}

async function list(env, rp, fresh) {
  const passkeys = await loadPasskeys(env);
  return ok({
    items: passkeys.map(describe),
    passphrase: Boolean(env.OWNER_PASSPHRASE),
    can_manage: fresh,
    // 删除后用浏览器的 Signal API 通知密码管理器，需要 rpID。
    rp_id: rp.rpID,
  });
}

async function registerOptions(env, rp, session, now) {
  const passkeys = await loadPasskeys(env);
  if (passkeys.length >= MAX_PASSKEYS) return fail(409, 'too_many_passkeys', `最多登记 ${MAX_PASSKEYS} 把通行密钥`);
  const options = registrationOptions({
    challenge: newChallenge(),
    rpName: 'xw7 面板',
    rpID: rp.rpID,
    userID: USER_ID,
    userName: 'owner',
    userDisplayName: 'Lucius7',
    timeout: CHALLENGE_SECONDS * 1000,
    exclude: passkeys,
  });
  return withCookies(ok(options), [await challengeCookie(env, 'register', options.challenge, now, session.iat)]);
}

async function register(request, env, rp, session, now) {
  const parsed = await body(request, 32 * 1024);
  if (parsed.error) return parsed.error;
  const { response, name } = parsed.value;
  const challenge = await readChallenge(request, env, 'register', now, session.iat);
  if (!challenge) return fail(400, 'challenge_expired', '登记请求过期了，请再试一次');
  let info;
  try {
    info = await verifyRegistration(response, { challenge, origin: rp.origin, rpID: rp.rpID });
  } catch (error) {
    console.warn(`passkey registration rejected: ${error.message}`);
    return fail(400, 'passkey_failed', '通行密钥登记失败');
  }
  const passkeys = await loadPasskeys(env);
  if (passkeys.some((item) => item.id === info.id)) return fail(409, 'duplicate_passkey', '这把通行密钥已经登记过了');
  if (passkeys.length >= MAX_PASSKEYS) return fail(409, 'too_many_passkeys', `最多登记 ${MAX_PASSKEYS} 把通行密钥`);
  const label = typeof name === 'string' ? name.trim().slice(0, 40) : '';
  passkeys.push({
    id: info.id,
    public_key: info.publicKey,
    algorithm: info.algorithm,
    counter: info.counter,
    transports: info.transports,
    aaguid: info.aaguid,
    multi_device: info.multiDevice,
    backed_up: info.backedUp,
    name: label || PROVIDERS[info.aaguid] || '通行密钥',
    created_at: new Date(now).toISOString(),
    last_used_at: null,
  });
  await savePasskeys(env, passkeys);
  return withCookies(ok(describe(passkeys.at(-1)), { status: 201 }), [CLEAR_CHALLENGE]);
}

async function remove(request, env) {
  const id = new URL(request.url).searchParams.get('id');
  if (!id || id.length > 512) return fail(400, 'invalid_id', '缺少通行密钥 id');
  const passkeys = await loadPasskeys(env);
  const rest = passkeys.filter((item) => item.id !== id);
  if (rest.length === passkeys.length) return fail(404, 'not_found', '没有这把通行密钥');
  // 口令登录关掉以后，删掉最后一把就再也登录不了了。
  if (!rest.length && !env.OWNER_PASSPHRASE) return fail(409, 'last_passkey', '口令登录已关闭，最后一把通行密钥不能删');
  await savePasskeys(env, rest);
  return ok({ removed: id, remaining: rest.map((item) => item.id) });
}
