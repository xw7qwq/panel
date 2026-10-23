import { passphraseMatches } from './auth.js';
import { publicHealth, validateHealthSnapshot } from './health.js';
import { HttpError, fail, ok } from './http.js';
import { validateLedgerSnapshot } from './ledger.js';

// 服务器把健康和记账快照推到这里。每个来源一个独立令牌，内容没变时不写 KV（免费额度每天 1000 次写入）。
const SOURCES = {
  health: { token: 'HEALTH_INGEST_TOKEN', validate: validateHealthSnapshot },
  ledger: { token: 'LEDGER_INGEST_TOKEN', validate: validateLedgerSnapshot },
};
const LIMIT = 4 * 1024 * 1024;

async function sha256(text) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

export async function ingest(request, env, name, now = Date.now()) {
  const source = SOURCES[name];
  if (!source) return fail(404, 'not_found', '没有这个数据源');
  if (request.method !== 'POST') return fail(405, 'method_not_allowed', '只接受 POST', { headers: { Allow: 'POST' } });
  const expected = env[source.token];
  if (!expected) return fail(503, 'ingest_not_configured', `${source.token} 还没有配置`);
  const header = request.headers.get('Authorization') || '';
  const token = header.startsWith('Bearer ') ? header.slice(7).trim() : '';
  if (!(await passphraseMatches(expected, token))) {
    return fail(401, 'unauthorized', '令牌无效', { headers: { 'WWW-Authenticate': 'Bearer' } });
  }
  if (!(request.headers.get('Content-Type') || '').includes('application/json')) return fail(415, 'unsupported_media_type', '请求体必须是 JSON');
  if (Number(request.headers.get('Content-Length') || 0) > LIMIT) return fail(413, 'payload_too_large', '快照不能超过 4 MB');
  const text = await request.text();
  if (text.length > LIMIT) return fail(413, 'payload_too_large', '快照不能超过 4 MB');
  let snapshot;
  try {
    snapshot = source.validate(JSON.parse(text));
  } catch (error) {
    if (error instanceof SyntaxError) return fail(400, 'invalid_json', '请求体不是合法的 JSON');
    if (error instanceof HttpError) return fail(error.status, error.code, error.message);
    throw error;
  }
  const digest = await sha256(text);
  const receivedAt = new Date(now).toISOString();
  const changed = (await env.PANEL_KV.get(`${name}:hash`)) !== digest;
  if (changed) {
    await env.PANEL_KV.put(`${name}:snapshot`, text, { metadata: { received_at: receivedAt, generated_at: snapshot.generated_at ?? null } });
    await env.PANEL_KV.put(`${name}:hash`, digest);
  }
  if (name === 'health') {
    // 公开摘要按“昨天”滚动，数据没变时过了零点也要更新。
    const summary = JSON.stringify(publicHealth(snapshot, now));
    if (changed || (await env.PANEL_KV.get('health:public')) !== summary) await env.PANEL_KV.put('health:public', summary);
  }
  return ok({ stored: changed, received_at: receivedAt, bytes: text.length });
}
