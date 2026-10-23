import assert from 'node:assert/strict';
import { afterEach, beforeEach, test } from 'node:test';
import { api, envelopeStream } from '../worker/api.js';
import { app } from '../worker/app.js';
import { SESSION_COOKIE, createSessionToken } from '../worker/auth.js';
import { healthSnapshot, ledgerSnapshot, memoryKv, request } from './_helpers.js';

const OJ_SUMMARY = {
  schema_version: 1,
  generated_at: '2026-03-10T00:00:00Z',
  today: '2026-03-10',
  solved: 3,
  counts: { today: 1, week: 3, month: 3, year: 3 },
  streak: { current: 3, longest: 3 },
  platforms: {},
  daily: { '2026-03-08': 1, '2026-03-09': 1, '2026-03-10': 1 },
  monthly: {},
  recent: [],
};
const MAC = { status: 'online', updated_at: 'u', collected_at: 'c', active_app: 'Secret', battery: { percent: 10 }, music: { state: 'paused', track: 'T', artist: 'A' } };

let realFetch;
let calls;

beforeEach(() => {
  realFetch = globalThis.fetch;
  calls = [];
  globalThis.fetch = async (input) => {
    const url = typeof input === 'string' ? input : input.url;
    calls.push(url);
    if (url === 'https://oj.test/data/summary.json') return Response.json(OJ_SUMMARY, { headers: { 'Last-Modified': 'Tue, 10 Mar 2026 00:00:00 GMT' } });
    if (url === 'https://oj.test/data/dashboard.json') return new Response('{"schemaVersion":2}');
    if (url === 'https://mac.test/api/now') return Response.json(MAC);
    if (url.startsWith('https://raw.test/main/')) return new Response('int main() {}\n');
    return new Response('missing', { status: 404 });
  };
});

afterEach(() => {
  globalThis.fetch = realFetch;
});

async function makeEnv() {
  const kv = memoryKv();
  await kv.put('health:public', JSON.stringify({ as_of: '2026-03-09', sleep_hours_avg7: 7 }));
  for (const [name, snapshot] of [['health', healthSnapshot()], ['ledger', ledgerSnapshot()]]) {
    await kv.put(`${name}:snapshot`, JSON.stringify(snapshot), { metadata: { generated_at: snapshot.generated_at } });
  }
  return {
    PANEL_KV: kv,
    SESSION_SECRET: 'secret',
    OJ_DATA_BASE: 'https://oj.test/data',
    MACFLARE_BASE: 'https://mac.test',
    SOLUTIONS_RAW_BASE: 'https://raw.test/main',
    ASSETS: { fetch: async (req) => new Response(`asset ${new URL(req.url).pathname}`, { headers: { 'Content-Type': 'text/html' } }) },
  };
}

async function signedIn() {
  return { Cookie: `${SESSION_COOKIE}=${await createSessionToken('secret')}` };
}

test('index lists every route with its access level', async () => {
  const response = await api(request('/api/v1/'), await makeEnv());
  const body = await response.json();
  assert.equal(response.headers.get('Access-Control-Allow-Origin'), '*');
  assert.ok(body.data.endpoints.some((route) => route.path === '/api/v1/me/ledger' && route.auth === 'session'));
  assert.equal(body.data.mcp, 'https://lucius7.dev/mcp');
});

test('public summary combines sources and hides private Mac fields', async () => {
  const response = await api(request('/api/v1/summary'), await makeEnv());
  const body = await response.json();
  assert.equal(body.data.oj.solved, 3);
  assert.deepEqual(Object.keys(body.data.now), ['status', 'updated_at', 'collected_at', 'music']);
  assert.equal(body.data.health.sleep_hours_avg7, 7);
  assert.deepEqual(body.source, { oj: 'ok', now: 'ok', health: 'ok' });
});

test('summary degrades per source when an upstream fails', async () => {
  const env = { ...(await makeEnv()), OJ_DATA_BASE: 'https://down.test' };
  const body = await (await api(request('/api/v1/summary'), env)).json();
  assert.equal(body.data.oj, null);
  assert.match(body.source.oj, /^unavailable/);
  assert.equal(body.data.now.status, 'online');
});

test('proxied JSON keeps the standard envelope without parsing the body', async () => {
  const response = await api(request('/api/v1/oj/summary'), await makeEnv());
  assert.equal(response.headers.get('Content-Type'), 'application/json; charset=utf-8');
  const body = await response.json();
  assert.equal(body.data.solved, 3);
  assert.equal(body.updated_at, '2026-03-10T00:00:00.000Z');
  assert.equal(body.source, 'oj');
  const text = await new Response(envelopeStream(new Response('[1,2]').body, null, 'x')).text();
  assert.deepEqual(JSON.parse(text), { data: [1, 2], updated_at: null, source: 'x' });
});

test('solution files are validated before proxying', async () => {
  const env = await makeEnv();
  const bad = await api(request('/api/v1/solutions/file?path=../../etc/passwd'), env);
  assert.equal(bad.status, 400);
  const good = await api(request('/api/v1/solutions/file?path=AtCoder/a.cpp'), env);
  assert.equal(good.headers.get('Content-Type'), 'text/plain; charset=utf-8');
  assert.equal(await good.text(), 'int main() {}\n');
  assert.ok(calls.includes('https://raw.test/main/AtCoder/a.cpp'));
});

test('private routes need a session and never get CORS headers', async () => {
  const env = await makeEnv();
  const anonymous = await api(request('/api/v1/me/ledger'), env);
  assert.equal(anonymous.status, 401);
  assert.equal(anonymous.headers.get('Access-Control-Allow-Origin'), null);
  const response = await api(request('/api/v1/me/summary', { headers: await signedIn() }), env);
  const body = await response.json();
  assert.equal(response.headers.get('Cache-Control'), 'no-store');
  assert.equal(response.headers.get('Access-Control-Allow-Origin'), null);
  assert.equal(body.data.ledger.month.month, '2026-03');
  assert.equal(body.data.now.active_app, 'Secret');
  assert.equal(body.data.health.metrics[0].key, 'steps');
  assert.equal((await api(request('/api/v1/me/ledger', { method: 'OPTIONS' }), env)).status, 405);
});

test('private snapshots are passed through unparsed with their generation time', async () => {
  const env = await makeEnv();
  const response = await api(request('/api/v1/me/health', { headers: await signedIn() }), env);
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('Cache-Control'), 'no-store');
  assert.equal(response.headers.get('Access-Control-Allow-Origin'), null);
  const body = await response.json();
  assert.deepEqual(body.data, JSON.parse(env.PANEL_KV.store.get('health:snapshot').value));
  assert.equal(body.updated_at, body.data.generated_at);
  assert.equal(body.source, 'health');
  const empty = { ...env, PANEL_KV: memoryKv() };
  const missing = await api(request('/api/v1/me/ledger', { headers: await signedIn() }), empty);
  assert.equal(missing.status, 503);
  assert.equal((await missing.json()).error.code, 'not_ready');
});

test('unknown routes and write methods are rejected', async () => {
  const env = await makeEnv();
  assert.equal((await api(request('/api/v1/nope'), env)).status, 404);
  assert.equal((await api(request('/api/v1/summary', { method: 'POST' }), env)).status, 405);
  assert.equal((await api(request('/api/v1/summary', { method: 'OPTIONS' }), env)).status, 204);
});

test('health summary reports when nothing has been pushed yet', async () => {
  const env = { ...(await makeEnv()), PANEL_KV: memoryKv() };
  const response = await api(request('/api/v1/health/summary'), env);
  assert.equal(response.status, 503);
  assert.equal((await response.json()).error.code, 'not_ready');
});

test('/me pages redirect to login without a session and are never cached', async () => {
  const env = await makeEnv();
  const anonymous = await app.fetch(request('/me/ledger/?month=2026-03'), env);
  assert.equal(anonymous.status, 302);
  assert.equal(anonymous.headers.get('Location'), '/login/?next=%2Fme%2Fledger%2F%3Fmonth%3D2026-03');
  const page = await app.fetch(request('/me/ledger/', { headers: await signedIn() }), env);
  assert.equal(page.status, 200);
  assert.equal(page.headers.get('Cache-Control'), 'private, no-store');
  assert.equal(page.headers.get('X-Robots-Tag'), 'noindex');
  const signedInLogin = await app.fetch(request('/login/?next=/me/health/', { headers: await signedIn() }), env);
  assert.equal(signedInLogin.headers.get('Location'), '/me/health/');
  assert.equal(await (await app.fetch(request('/oj/'), env)).text(), 'asset /oj/');
});

test('grants can be listed and revoked by the signed-in owner only', async () => {
  const revoked = [];
  const env = {
    ...(await makeEnv()),
    OAUTH_PROVIDER: {
      listUserGrants: async () => ({ items: [{ id: 'g1', clientId: 'c1', scope: ['panel:read'], metadata: { client: 'Claude' }, createdAt: 1_773_000_000, expiresAt: 1_775_592_000 }] }),
      revokeGrant: async (id, user) => revoked.push([id, user]),
    },
  };
  assert.equal((await app.fetch(request('/api/v1/me/grants'), env)).status, 401);
  const list = await (await app.fetch(request('/api/v1/me/grants', { headers: await signedIn() }), env)).json();
  assert.deepEqual(list.data[0], { id: 'g1', client: 'Claude', scope: ['panel:read'], created_at: '2026-03-08T20:00:00.000Z', expires_at: '2026-04-07T20:00:00.000Z' });
  const cross = await app.fetch(request('/api/v1/me/grants?id=g1', { method: 'DELETE', headers: { ...(await signedIn()), Origin: 'https://evil.example' } }), env);
  assert.equal(cross.status, 403);
  const ok = await app.fetch(request('/api/v1/me/grants?id=g1', { method: 'DELETE', headers: { ...(await signedIn()), Origin: 'https://lucius7.dev' } }), env);
  assert.equal(ok.status, 200);
  assert.deepEqual(revoked, [['g1', 'owner']]);
});
