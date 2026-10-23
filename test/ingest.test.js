import assert from 'node:assert/strict';
import test from 'node:test';
import { ingest } from '../worker/ingest.js';
import { healthSnapshot, ledgerSnapshot, memoryKv, request } from './_helpers.js';

function post(name, body, { token = 'health-token', type = 'application/json' } = {}) {
  return request(`/api/v1/ingest/${name}`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': type },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
}

function env() {
  return { PANEL_KV: memoryKv(), HEALTH_INGEST_TOKEN: 'health-token', LEDGER_INGEST_TOKEN: 'ledger-token' };
}

test('ingest stores a new snapshot once and skips unchanged ones', async () => {
  const context = env();
  const now = Date.parse('2026-03-10T04:00:00Z');
  const first = await ingest(post('health', healthSnapshot()), context, 'health', now);
  assert.equal(first.status, 200);
  assert.equal((await first.json()).data.stored, true);
  assert.deepEqual(await context.PANEL_KV.get('health:snapshot', 'json'), healthSnapshot());
  assert.equal(context.PANEL_KV.store.get('health:snapshot').metadata.generated_at, '2026-03-10T08:00:00Z');
  const summary = await context.PANEL_KV.get('health:public', 'json');
  assert.equal(summary.as_of, '2026-03-09');

  const writes = context.PANEL_KV.writes;
  const again = await ingest(post('health', healthSnapshot()), context, 'health', now);
  assert.equal((await again.json()).data.stored, false);
  assert.equal(context.PANEL_KV.writes, writes);

  // 第二天同样的快照：数据没变，公开摘要也要滚动到新的“昨天”。
  await ingest(post('health', healthSnapshot()), context, 'health', now + 86_400_000);
  assert.equal((await context.PANEL_KV.get('health:public', 'json')).as_of, '2026-03-10');
});

test('ingest checks the token per source, the media type and the schema', async () => {
  const context = env();
  assert.equal((await ingest(post('health', healthSnapshot(), { token: 'ledger-token' }), context, 'health')).status, 401);
  assert.equal((await ingest(post('ledger', ledgerSnapshot(), { token: 'health-token' }), context, 'ledger')).status, 401);
  assert.equal((await ingest(post('health', healthSnapshot(), { type: 'text/plain' }), context, 'health')).status, 415);
  assert.equal((await ingest(post('health', '{oops'), context, 'health')).status, 400);
  const invalid = await ingest(post('health', { schema_version: 9 }), context, 'health');
  assert.equal(invalid.status, 400);
  assert.equal((await invalid.json()).error.code, 'invalid_snapshot');
  assert.equal((await ingest(post('other', {}), context, 'other')).status, 404);
  assert.equal((await ingest(request('/api/v1/ingest/health'), context, 'health')).status, 405);
  assert.equal((await ingest(post('ledger', ledgerSnapshot(), { token: 'x' }), { PANEL_KV: memoryKv() }, 'ledger')).status, 503);
  assert.equal(context.PANEL_KV.writes, 0);
});

test('ledger snapshots are stored without a public copy', async () => {
  const context = env();
  const response = await ingest(post('ledger', ledgerSnapshot(), { token: 'ledger-token' }), context, 'ledger');
  assert.equal(response.status, 200);
  assert.deepEqual([...context.PANEL_KV.store.keys()].sort(), ['ledger:hash', 'ledger:snapshot']);
});
