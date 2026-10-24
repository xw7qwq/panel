import assert from 'node:assert/strict';
import test from 'node:test';
import { app } from '../worker/app.js';
import { SESSION_COOKIE, createSessionToken, readSession } from '../worker/auth.js';
import { CHALLENGE_COOKIE, STORE_KEY, passkeyApi } from '../worker/passkey.js';
import { authenticator } from './_authenticator.js';
import { ORIGIN, memoryKv, request } from './_helpers.js';

const NOW = Date.parse('2026-10-24T08:00:00Z');
const MINUTE = 60_000;

function makeEnv(overrides = {}) {
  return { SITE_ORIGIN: ORIGIN, PASSKEY_RP_ID: 'lucius7.dev', SESSION_SECRET: 'test-secret', OWNER_PASSPHRASE: 'correct horse', PANEL_KV: memoryKv(), ...overrides };
}

async function session(env, issuedAt = NOW) {
  return `${SESSION_COOKIE}=${await createSessionToken(env.SESSION_SECRET, issuedAt)}`;
}

function call(env, path, { method = 'GET', body, cookies = [], origin = ORIGIN, now = NOW } = {}) {
  const headers = { Accept: 'application/json' };
  if (origin) headers.Origin = origin;
  if (cookies.length) headers.Cookie = cookies.join('; ');
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  return passkeyApi(request(path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) }), env, now);
}

function challengeOf(response) {
  return response.headers
    .getSetCookie()
    .find((cookie) => cookie.startsWith(`${CHALLENGE_COOKIE}=`))
    .split(';')[0];
}

async function errorCode(response) {
  return (await response.json()).error.code;
}

async function stored(env) {
  return JSON.parse(env.PANEL_KV.store.get(STORE_KEY).value);
}

// 走一遍登记：要 options、认证器签名、提交。
async function enroll(env, device, { cookie, now = NOW, overrides } = {}) {
  cookie ??= await session(env, now);
  const options = await call(env, '/api/v1/me/passkeys/options', { method: 'POST', cookies: [cookie], now });
  assert.equal(options.status, 200);
  const response = device.register((await options.json()).data, overrides);
  return call(env, '/api/v1/me/passkeys', { method: 'POST', body: { response }, cookies: [cookie, challengeOf(options)], now });
}

async function begin(env, now = NOW) {
  const options = await call(env, '/api/v1/auth/passkey/options', { method: 'POST', now });
  assert.equal(options.status, 200);
  return { options: (await options.json()).data, challenge: challengeOf(options) };
}

function verify(env, challenge, response, { next, now = NOW } = {}) {
  return call(env, '/api/v1/auth/passkey/verify', { method: 'POST', body: { response, next }, cookies: [challenge], now });
}

test('methods say which sign-in options are on', async () => {
  const env = makeEnv();
  assert.deepEqual((await (await call(env, '/api/v1/auth/methods')).json()).data, { passphrase: true, passkey: false });
  assert.equal((await enroll(env, authenticator())).status, 201);
  assert.deepEqual((await (await call(env, '/api/v1/auth/methods')).json()).data, { passphrase: true, passkey: true });
  assert.deepEqual((await (await call({ ...env, OWNER_PASSPHRASE: '' }, '/api/v1/auth/methods')).json()).data, { passphrase: false, passkey: true });
  assert.deepEqual((await (await call({}, '/api/v1/auth/methods')).json()).data, { passphrase: false, passkey: false });
  assert.equal((await call(env, '/api/v1/auth/methods', { method: 'POST' })).status, 405);
  assert.equal((await call(env, '/api/v1/auth/other')).status, 404);
  assert.equal(await errorCode(await call({ SITE_ORIGIN: ORIGIN, PANEL_KV: memoryKv() }, '/api/v1/auth/passkey/options', { method: 'POST' })), 'auth_not_configured');
});

test('registration options need a recent same-origin session', async () => {
  const env = makeEnv();
  assert.equal((await call(env, '/api/v1/me/passkeys/options', { method: 'POST' })).status, 401);
  const stale = await session(env, NOW - 16 * MINUTE);
  assert.equal(await errorCode(await call(env, '/api/v1/me/passkeys/options', { method: 'POST', cookies: [stale] })), 'reauth_required');
  const fresh = await session(env);
  assert.equal(await errorCode(await call(env, '/api/v1/me/passkeys/options', { method: 'POST', cookies: [fresh], origin: 'https://evil.example' })), 'cross_origin');
  assert.equal((await call(env, '/api/v1/me/passkeys/options', { cookies: [fresh] })).status, 405);

  const response = await call(env, '/api/v1/me/passkeys/options', { method: 'POST', cookies: [fresh] });
  assert.equal(response.status, 200);
  const options = (await response.json()).data;
  assert.equal(options.rp.id, 'lucius7.dev');
  assert.equal(options.user.name, 'owner');
  assert.deepEqual(options.authenticatorSelection, { residentKey: 'required', userVerification: 'required', requireResidentKey: true });
  assert.equal(options.attestation, 'none');
  assert.deepEqual(options.excludeCredentials, []);
  const cookie = response.headers.getSetCookie().find((value) => value.startsWith(CHALLENGE_COOKIE));
  assert.match(cookie, /^__Host-xw7_passkey=[\w-]+\.[\w-]+; Path=\/; Max-Age=300; HttpOnly; Secure; SameSite=Strict$/);
});

test('a registered passkey is stored as a public key and listed without it', async () => {
  const env = makeEnv();
  const device = authenticator();
  const created = await enroll(env, device);
  assert.equal(created.status, 201);
  assert.ok(created.headers.getSetCookie().some((cookie) => cookie.startsWith(`${CHALLENGE_COOKIE}=;`) && cookie.includes('Max-Age=0')));
  const item = (await created.json()).data;
  assert.equal(item.id, device.id);
  assert.equal(item.name, 'iCloud 钥匙串');
  assert.equal(item.synced, true);
  assert.equal(item.last_used_at, null);

  const [saved] = await stored(env);
  assert.equal(saved.id, device.id);
  assert.equal(saved.counter, 0);
  assert.equal(saved.backed_up, true);
  assert.equal(saved.algorithm, -7);
  assert.deepEqual(Object.keys(saved.public_key).sort(), ['crv', 'kty', 'x', 'y']);
  assert.deepEqual(saved.transports, ['hybrid', 'internal']);

  const list = await (await call(env, '/api/v1/me/passkeys', { cookies: [await session(env)] })).json();
  assert.deepEqual(Object.keys(list.data).sort(), ['can_manage', 'items', 'passphrase', 'rp_id']);
  assert.equal(list.data.items.length, 1);
  assert.equal(list.data.items[0].public_key, undefined);
  assert.equal(list.data.can_manage, true);
  assert.equal(list.data.rp_id, 'lucius7.dev');
  const later = await (await call(env, '/api/v1/me/passkeys', { cookies: [await session(env, NOW - 20 * MINUTE)] })).json();
  assert.equal(later.data.can_manage, false);

  // 同一把再登记：options 里排除它，硬交上来也拒绝。
  const again = await call(env, '/api/v1/me/passkeys/options', { method: 'POST', cookies: [await session(env)] });
  assert.deepEqual((await again.json()).data.excludeCredentials.map((entry) => entry.id), [device.id]);
  assert.equal(await errorCode(await enroll(env, device)), 'duplicate_passkey');
  assert.equal((await stored(env)).length, 1);
});

test('registration rejects other origins, missing verification and bad challenges', async () => {
  const env = makeEnv();
  const device = authenticator();
  assert.equal(await errorCode(await enroll(env, device, { overrides: { origin: 'https://evil.example' } })), 'passkey_failed');
  assert.equal(await errorCode(await enroll(env, device, { overrides: { rpID: 'evil.example' } })), 'passkey_failed');
  assert.equal(await errorCode(await enroll(env, device, { overrides: { uv: false } })), 'passkey_failed');

  const cookie = await session(env);
  const options = await call(env, '/api/v1/me/passkeys/options', { method: 'POST', cookies: [cookie] });
  const response = device.register((await options.json()).data);
  const submit = (cookies, now = NOW) => call(env, '/api/v1/me/passkeys', { method: 'POST', body: { response }, cookies, now });
  assert.equal(await errorCode(await submit([cookie])), 'challenge_expired');
  assert.equal(await errorCode(await submit([cookie, challengeOf(options)], NOW + 6 * MINUTE)), 'challenge_expired');
  assert.equal(await errorCode(await submit([cookie, `${challengeOf(options)}x`])), 'challenge_expired');
  const login = await begin(env);
  assert.equal(await errorCode(await submit([cookie, login.challenge])), 'challenge_expired');
  assert.equal((await call(env, '/api/v1/me/passkeys', { method: 'POST', body: { response }, cookies: [challengeOf(options)] })).status, 401);
  assert.equal(await errorCode(await call(env, '/api/v1/me/passkeys', { method: 'POST', body: { response }, cookies: [cookie, challengeOf(options)], origin: 'https://evil.example' })), 'cross_origin');
  assert.equal(env.PANEL_KV.store.has(STORE_KEY), false);

  // challenge 绑定要它的那张会话 Cookie，换一张不行。
  assert.equal(await errorCode(await submit([await session(env, NOW - 1000), challengeOf(options)])), 'challenge_expired');
  assert.equal(env.PANEL_KV.store.has(STORE_KEY), false);

  // 要 options 时会话还算新，交上来时过了 15 分钟的线也照样能登记。
  const aging = await session(env, NOW - 14 * MINUTE);
  const late = await call(env, '/api/v1/me/passkeys/options', { method: 'POST', cookies: [aging] });
  const lateResponse = device.register((await late.json()).data);
  const accepted = await call(env, '/api/v1/me/passkeys', { method: 'POST', body: { response: lateResponse }, cookies: [aging, challengeOf(late)], now: NOW + 2 * MINUTE });
  assert.equal(accepted.status, 201);
});

test('signing in with a passkey issues the normal session cookie', async () => {
  const env = makeEnv();
  const device = authenticator();
  await enroll(env, device);
  const writes = env.PANEL_KV.writes;

  const { options, challenge } = await begin(env, NOW + 60 * MINUTE);
  assert.equal(options.rpId, 'lucius7.dev');
  assert.equal(options.userVerification, 'required');
  assert.equal(options.allowCredentials, undefined);
  assert.equal(env.PANEL_KV.writes, writes, 'options must not write KV');

  const response = await verify(env, challenge, device.login(options), { next: '/me/health/', now: NOW + 61 * MINUTE });
  assert.equal(response.status, 200);
  assert.equal((await response.json()).data.next, '/me/health/');
  const cookies = response.headers.getSetCookie();
  const token = cookies.find((cookie) => cookie.startsWith(`${SESSION_COOKIE}=`));
  assert.match(token, /HttpOnly; Secure; SameSite=Lax$/);
  assert.ok(cookies.some((cookie) => cookie.startsWith('xw7_signed_in=1')));
  assert.ok(cookies.some((cookie) => cookie.startsWith(`${CHALLENGE_COOKIE}=;`)));
  const signedIn = await readSession(request('/', { headers: { Cookie: token.split(';')[0] } }), env, NOW + 61 * MINUTE);
  assert.equal(signedIn.sub, 'owner');
  assert.equal(signedIn.iat, Math.floor((NOW + 61 * MINUTE) / 1000));

  const [saved] = await stored(env);
  assert.equal(saved.last_used_at, new Date(NOW + 61 * MINUTE).toISOString());

  // 只跳回本站路径。
  const second = await begin(env);
  const outside = await verify(env, second.challenge, device.login(second.options), { next: '//evil.example/' });
  assert.equal((await outside.json()).data.next, '/me/');
});

test('Ed25519 and RSA passkeys sign in too', async () => {
  for (const key of ['ed25519', 'rs256']) {
    const env = makeEnv();
    const device = authenticator({ key, synced: false, aaguid: '08987058-cadc-4b81-b6e1-30de50dcbe96' });
    const created = await (await enroll(env, device)).json();
    assert.equal(created.data.name, 'Windows Hello');
    assert.equal(created.data.synced, false);
    const { options, challenge } = await begin(env);
    assert.equal((await verify(env, challenge, device.login(options))).status, 200, key);
    assert.equal((await stored(env))[0].algorithm, key === 'ed25519' ? -8 : -257);
  }
});

test('a counting authenticator must keep counting up', async () => {
  const env = makeEnv();
  const device = authenticator({ step: 1, synced: false });
  await enroll(env, device);
  let started = await begin(env);
  assert.equal((await verify(env, started.challenge, device.login(started.options))).status, 200);
  assert.equal((await stored(env))[0].counter, 1);
  // 复制出来的认证器会报出不比上次大的计数。
  started = await begin(env);
  assert.equal(await errorCode(await verify(env, started.challenge, device.login(started.options, { counter: 1 }))), 'passkey_failed');
  started = await begin(env);
  assert.equal((await verify(env, started.challenge, device.login(started.options, { counter: 7 }))).status, 200);
  assert.equal((await stored(env))[0].counter, 7);
});

test('a used challenge cannot be replayed', async () => {
  const env = makeEnv();
  const device = authenticator();
  await enroll(env, device);
  const { options, challenge } = await begin(env);
  const assertion = device.login(options);
  assert.equal((await verify(env, challenge, assertion)).status, 200);
  const replay = await verify(env, challenge, assertion);
  assert.equal(replay.status, 400);
  assert.equal(await errorCode(replay), 'passkey_failed');
  assert.equal(replay.headers.getSetCookie().length, 0);
});

test('sign-in rejects unknown passkeys, forged assertions and expired challenges', async () => {
  const env = makeEnv();
  const device = authenticator();
  await enroll(env, device);
  const attempt = async (make, options = {}) => {
    const started = await begin(env);
    const response = await verify(env, started.challenge, make(started.options), options);
    assert.equal(response.headers.getSetCookie().length, 0);
    return errorCode(response);
  };

  assert.equal(await attempt((options) => authenticator().login(options)), 'unknown_passkey');
  assert.equal(await attempt((options) => device.login(options, { origin: 'https://panel.evil.example' })), 'passkey_failed');
  assert.equal(await attempt((options) => device.login(options, { rpID: 'evil.example' })), 'passkey_failed');
  assert.equal(await attempt((options) => device.login(options, { uv: false })), 'passkey_failed');
  assert.equal(await attempt((options) => device.login(options, { challenge: 'b3RoZXItY2hhbGxlbmdl' })), 'passkey_failed');
  assert.equal(await attempt((options) => device.login(options, { signature: Buffer.from('3006020101020101', 'hex') })), 'passkey_failed');
  assert.equal(await attempt((options) => device.login(options), { now: NOW + 6 * MINUTE }), 'challenge_expired');
  assert.equal(await attempt(() => 'not a credential'), 'unknown_passkey');

  const { options } = await begin(env);
  assert.equal(await errorCode(await call(env, '/api/v1/auth/passkey/verify', { method: 'POST', body: { response: device.login(options) } })), 'challenge_expired');
  assert.equal(await errorCode(await call(env, '/api/v1/auth/passkey/options', { method: 'POST', origin: 'https://evil.example' })), 'cross_origin');
  assert.equal((await call(env, '/api/v1/auth/passkey/options')).status, 405);

  const limited = { ...env, LOGIN_LIMITER: { limit: async () => ({ success: false }) } };
  const started = await begin(limited);
  assert.equal(await errorCode(await verify(limited, started.challenge, device.login(started.options))), 'rate_limited');
  assert.equal((await stored(env))[0].last_used_at, null);
});

test('deleting passkeys needs a recent session and keeps the last one when the passphrase is off', async () => {
  const env = makeEnv();
  const first = authenticator();
  const second = authenticator({ aaguid: '00000000-0000-0000-0000-000000000000', synced: false });
  await enroll(env, first);
  assert.equal((await (await enroll(env, second)).json()).data.name, '通行密钥');
  const fresh = await session(env);
  const remove = (id, options = {}) => call(env, `/api/v1/me/passkeys?id=${encodeURIComponent(id)}`, { method: 'DELETE', cookies: [fresh], ...options });

  assert.equal(await errorCode(await remove(first.id, { cookies: [await session(env, NOW - 16 * MINUTE)] })), 'reauth_required');
  assert.equal(await errorCode(await remove(first.id, { origin: 'https://evil.example' })), 'cross_origin');
  assert.equal((await remove(first.id, { cookies: [] })).status, 401);
  assert.equal((await remove('missing')).status, 404);
  assert.equal(await errorCode(await call(env, '/api/v1/me/passkeys', { method: 'DELETE', cookies: [fresh] })), 'invalid_id');

  const passkeyOnly = { ...env, OWNER_PASSPHRASE: undefined };
  const removed = await call(passkeyOnly, `/api/v1/me/passkeys?id=${encodeURIComponent(first.id)}`, { method: 'DELETE', cookies: [fresh] });
  assert.deepEqual((await removed.json()).data, { removed: first.id, remaining: [second.id] });
  const last = await call(passkeyOnly, `/api/v1/me/passkeys?id=${encodeURIComponent(second.id)}`, { method: 'DELETE', cookies: [fresh] });
  assert.equal(last.status, 409);
  assert.equal(await errorCode(last), 'last_passkey');

  // 口令还在时可以删光。
  assert.equal((await remove(second.id)).status, 200);
  assert.deepEqual(await stored(env), []);
  const { options, challenge } = await begin(env);
  assert.equal(await errorCode(await verify(env, challenge, second.login(options))), 'unknown_passkey');
});

test('the app routes passkey endpoints and lets a signed-in owner re-verify', async () => {
  const env = { ...makeEnv(), ASSETS: { fetch: async (req) => new Response(`asset ${new URL(req.url).pathname}`) } };
  const methods = await app.fetch(request('/api/v1/auth/methods'), env);
  assert.deepEqual((await methods.json()).data, { passphrase: true, passkey: false });
  assert.equal((await app.fetch(request('/api/v1/me/passkeys'), env)).status, 401);
  assert.equal((await app.fetch(request('/api/v1/me/passkeysx'), env)).status, 404);

  const cookie = { Cookie: await session(env, Date.now()) };
  const redirected = await app.fetch(request('/login/?next=/me/', { headers: cookie }), env);
  assert.equal(redirected.headers.get('Location'), '/me/');
  const reauth = await app.fetch(request('/login/?reauth=1&next=/me/', { headers: cookie }), env);
  assert.equal(await reauth.text(), 'asset /login/');
});
