import assert from 'node:assert/strict';
import test from 'node:test';
import {
  HINT_COOKIE,
  SESSION_COOKIE,
  createSessionToken,
  login,
  logout,
  passphraseMatches,
  readSession,
  safeNext,
  verifySessionToken,
} from '../worker/auth.js';
import { ORIGIN, request } from './_helpers.js';

const SECRET = 'test-secret';
const env = { OWNER_PASSPHRASE: 'correct horse', SESSION_SECRET: SECRET };

function form(fields, headers = { Origin: ORIGIN }) {
  return request('/login/', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', ...headers },
    body: new URLSearchParams(fields).toString(),
  });
}

test('session tokens verify, expire and reject tampering', async () => {
  const now = Date.parse('2026-03-01T00:00:00Z');
  const token = await createSessionToken(SECRET, now);
  assert.equal((await verifySessionToken(SECRET, token, now)).sub, 'owner');
  assert.equal(await verifySessionToken('other-secret', token, now), null);
  assert.equal(await verifySessionToken(SECRET, `${token}x`, now), null);
  assert.equal(await verifySessionToken(SECRET, `${token}.extra`, now), null);
  assert.equal(await verifySessionToken(SECRET, token, now + 31 * 86_400_000), null);
  const [payload, signature] = token.split('.');
  const forged = Buffer.from(JSON.stringify({ sub: 'owner', iat: 0, exp: 4_000_000_000 })).toString('base64url');
  assert.equal(await verifySessionToken(SECRET, `${forged}.${signature}`, now), null);
  assert.ok(payload);
});

test('readSession reads only the signed cookie', async () => {
  const token = await createSessionToken(SECRET);
  assert.ok(await readSession(request('/', { headers: { Cookie: `${HINT_COOKIE}=1; ${SESSION_COOKIE}=${token}` } }), env));
  assert.equal(await readSession(request('/', { headers: { Cookie: `${HINT_COOKIE}=1` } }), env), null);
  assert.equal(await readSession(request('/', { headers: { Cookie: `${SESSION_COOKIE}=${token}` } }), { SESSION_SECRET: '' }), null);
});

test('passphrase comparison', async () => {
  assert.equal(await passphraseMatches('abc', 'abc'), true);
  assert.equal(await passphraseMatches('abc', 'abd'), false);
  assert.equal(await passphraseMatches('abc', ''), false);
  assert.equal(await passphraseMatches('', ''), false);
  assert.equal(await passphraseMatches('a'.repeat(2000), 'a'.repeat(2000)), false);
});

test('safeNext only allows same-site paths', () => {
  assert.equal(safeNext('/me/ledger/?month=2026-03'), '/me/ledger/?month=2026-03');
  assert.equal(safeNext('/authorize?client_id=x&state=y'), '/authorize?client_id=x&state=y');
  for (const value of ['//evil.example/', 'https://evil.example/', '/\\evil.example', 'me/', '', null, undefined, 42]) {
    assert.equal(safeNext(value), '/me/', String(value));
  }
});

test('login accepts the passphrase and sets both cookies', async () => {
  const response = await login(form({ passphrase: 'correct horse', next: '/me/health/' }), env);
  assert.equal(response.status, 303);
  assert.equal(response.headers.get('Location'), '/me/health/');
  const cookies = response.headers.getSetCookie();
  assert.equal(cookies.length, 2);
  assert.match(cookies[0], /^__Host-xw7_session=[\w-]+\.[\w-]+; Path=\/; Max-Age=2592000; HttpOnly; Secure; SameSite=Lax$/);
  assert.match(cookies[1], /^xw7_signed_in=1; .*Secure; SameSite=Lax$/);
  assert.doesNotMatch(cookies[1], /HttpOnly/);
});

test('login rejects wrong passphrases, cross-site posts and rate-limited clients', async () => {
  const wrong = await login(form({ passphrase: 'nope', next: '/me/' }), env);
  assert.equal(wrong.status, 303);
  assert.equal(wrong.headers.get('Location'), '/login/?error=wrong&next=%2Fme%2F');
  assert.equal(wrong.headers.getSetCookie().length, 0);

  const crossSite = await login(form({ passphrase: 'correct horse' }, { Origin: 'https://evil.example' }), env);
  assert.equal(crossSite.status, 403);

  const limited = await login(form({ passphrase: 'correct horse' }), { ...env, LOGIN_LIMITER: { limit: async () => ({ success: false }) } });
  assert.equal(limited.headers.get('Location'), '/login/?error=rate&next=%2Fme%2F');

  const unconfigured = await login(form({ passphrase: 'x' }), {});
  assert.equal(unconfigured.status, 503);

  // 删掉 OWNER_PASSPHRASE 以后只能用通行密钥。
  const disabled = await login(form({ passphrase: 'correct horse', next: '/me/' }), { SESSION_SECRET: SECRET });
  assert.equal(disabled.headers.get('Location'), '/login/?error=disabled&next=%2Fme%2F');
  assert.equal(disabled.headers.getSetCookie().length, 0);
});

test('logout needs a same-origin POST and clears the cookies', async () => {
  assert.equal(logout(request('/logout')).status, 405);
  assert.equal(logout(request('/logout', { method: 'POST', headers: { Origin: 'https://evil.example' } })).status, 403);
  const response = logout(request('/logout', { method: 'POST', headers: { Origin: ORIGIN } }));
  assert.equal(response.status, 303);
  assert.ok(response.headers.getSetCookie().every((cookie) => cookie.includes('Max-Age=0')));
});

test('other hostnames redirect to the canonical origin, local previews do not', async () => {
  const { canonicalRedirect } = await import('../worker/http.js');
  const moved = canonicalRedirect(new Request('https://panel.lucius7.dev/oj/?x=1'), 'https://lucius7.dev');
  assert.equal(moved.status, 301);
  assert.equal(moved.headers.get('Location'), 'https://lucius7.dev/oj/?x=1');
  assert.equal(canonicalRedirect(new Request('https://lucius7.dev/oj/'), 'https://lucius7.dev'), null);
  assert.equal(canonicalRedirect(new Request('http://127.0.0.1:8787/'), 'https://lucius7.dev'), null);
  assert.equal(canonicalRedirect(new Request('https://panel.someone.workers.dev/'), 'https://lucius7.dev'), null);
  assert.equal(canonicalRedirect(new Request('https://panel.lucius7.dev/'), ''), null);
});
