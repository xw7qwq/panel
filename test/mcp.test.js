import assert from 'node:assert/strict';
import { afterEach, beforeEach, test } from 'node:test';
import { PROTOCOL_VERSIONS, handleMcp } from '../worker/mcp.js';
import { TOOLS } from '../worker/tools.js';
import { healthSnapshot, ledgerSnapshot, memoryKv, request } from './_helpers.js';

let realFetch;

beforeEach(() => {
  realFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response('unavailable', { status: 503 });
});

afterEach(() => {
  globalThis.fetch = realFetch;
});

async function env() {
  const kv = memoryKv();
  await kv.put('health:snapshot', JSON.stringify(healthSnapshot()));
  await kv.put('ledger:snapshot', JSON.stringify(ledgerSnapshot()));
  return { PANEL_KV: kv, OJ_DATA_BASE: 'https://oj.test', MACFLARE_BASE: 'https://mac.test' };
}

function rpc(body, headers = {}) {
  return request('/mcp', { method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', ...headers }, body: JSON.stringify(body) });
}

async function call(name, args = {}) {
  const response = await handleMcp(rpc({ jsonrpc: '2.0', id: 7, method: 'tools/call', params: { name, arguments: args } }), await env());
  return (await response.json()).result;
}

test('initialize negotiates the protocol version', async () => {
  const known = await (await handleMcp(rpc({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18' } }), await env())).json();
  assert.equal(known.result.protocolVersion, '2025-06-18');
  assert.deepEqual(known.result.capabilities, { tools: { listChanged: false } });
  const future = await (await handleMcp(rpc({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2099-01-01' } }), await env())).json();
  assert.equal(future.result.protocolVersion, PROTOCOL_VERSIONS[0]);
});

test('every tool is declared read-only with a closed input schema', async () => {
  const body = await (await handleMcp(rpc({ jsonrpc: '2.0', id: 2, method: 'tools/list' }), await env())).json();
  assert.equal(body.result.tools.length, TOOLS.length);
  for (const tool of body.result.tools) {
    assert.equal(tool.annotations.readOnlyHint, true, tool.name);
    assert.equal(tool.annotations.destructiveHint, false, tool.name);
    assert.equal(tool.inputSchema.type, 'object', tool.name);
    assert.equal(tool.inputSchema.additionalProperties, false, tool.name);
  }
});

test('transport rules: GET, cross-site, unknown versions, notifications and batches', async () => {
  assert.equal((await handleMcp(request('/mcp'), await env())).status, 405);
  assert.equal((await handleMcp(rpc({ jsonrpc: '2.0', id: 1, method: 'ping' }, { Origin: 'https://evil.example' }), await env())).status, 403);
  assert.equal((await handleMcp(rpc({ jsonrpc: '2.0', id: 1, method: 'ping' }, { 'MCP-Protocol-Version': '1999-01-01' }), await env())).status, 400);
  assert.equal((await handleMcp(rpc({ jsonrpc: '2.0', method: 'notifications/initialized' }), await env())).status, 202);
  const parse = await handleMcp(request('/mcp', { method: 'POST', body: '{' }), await env());
  assert.equal((await parse.json()).error.code, -32700);
  const batch = await (await handleMcp(rpc([{ jsonrpc: '2.0', id: 1, method: 'ping' }, { jsonrpc: '2.0', method: 'notifications/x' }, { jsonrpc: '2.0', id: 2, method: 'nope' }]), await env())).json();
  assert.deepEqual(batch.map((reply) => reply.id), [1, 2]);
  assert.equal(batch[1].error.code, -32601);
});

test('ledger and health tools read the pushed snapshots', async () => {
  const summary = await call('get_ledger_summary', { month: '2026-02' });
  assert.equal(summary.structuredContent.month.month, '2026-02');
  const series = await call('get_health_series', { metrics: ['steps'], limit: 1 });
  assert.deepEqual(series.structuredContent.points, [{ date: '2026-03-10', steps: 10000 }]);
  const transactions = await call('list_ledger_transactions', { account: 'Expenses:Rent' });
  assert.equal(transactions.structuredContent.transactions.length, 1);
  assert.ok(JSON.parse(transactions.content[0].text).transactions);
});

test('tool errors are reported as tool results, not protocol errors', async () => {
  const bad = await call('get_ledger_summary', { month: 'March' });
  assert.equal(bad.isError, true);
  const offline = await call('get_oj_stats');
  assert.equal(offline.isError, true);
  assert.match(offline.content[0].text, /刷题数据暂时取不到/);
  const path = await call('get_solution_source', { path: '../x.cpp' });
  assert.equal(path.isError, true);
  const response = await handleMcp(rpc({ jsonrpc: '2.0', id: 9, method: 'tools/call', params: { name: 'missing' } }), await env());
  assert.equal((await response.json()).error.code, -32602);
});

test('tools report missing snapshots clearly', async () => {
  const response = await handleMcp(rpc({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'get_health_summary', arguments: {} } }), { PANEL_KV: memoryKv() });
  const { result } = await response.json();
  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /健康数据还没有推送/);
});
