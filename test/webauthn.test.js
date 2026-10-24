import assert from 'node:assert/strict';
import test from 'node:test';
import { decodeCbor, derToRaw, newChallenge, registrationOptions, verifyRegistration } from '../worker/webauthn.js';
import { authenticator, cbor } from './_authenticator.js';

const expected = { origin: 'https://lucius7.dev', rpID: 'lucius7.dev' };

function options() {
  return registrationOptions({ challenge: newChallenge(), rpName: '面板', rpID: 'lucius7.dev', userID: new TextEncoder().encode('xw7-owner'), userName: 'owner', userDisplayName: 'Lucius7', timeout: 300_000 });
}

test('registration options ask for a discoverable, user-verified passkey', () => {
  const value = registrationOptions({
    challenge: 'abc',
    rpName: '面板',
    rpID: 'lucius7.dev',
    userID: new TextEncoder().encode('xw7-owner'),
    userName: 'owner',
    userDisplayName: 'Lucius7',
    timeout: 1000,
    exclude: [{ id: 'one', transports: ['internal'] }, { id: 'two', transports: [] }],
  });
  assert.equal(value.user.id, 'eHc3LW93bmVy');
  assert.deepEqual(value.pubKeyCredParams.map((item) => item.alg), [-8, -7, -257]);
  assert.deepEqual(value.excludeCredentials, [{ type: 'public-key', id: 'one', transports: ['internal'] }, { type: 'public-key', id: 'two' }]);
  assert.equal(newChallenge().length, 43);
  assert.notEqual(newChallenge(), newChallenge());
});

test('the CBOR decoder reads what WebAuthn uses and nothing else', () => {
  const value = new Map([['fmt', 'none'], [1, -7], [-257, new Uint8Array([1, 2])], ['list', [true, false, null, 70000]]]);
  const { value: decoded, end } = decodeCbor(cbor(value));
  assert.equal(end, cbor(value).length);
  assert.equal(decoded.get('fmt'), 'none');
  assert.equal(decoded.get(1), -7);
  assert.deepEqual([...decoded.get(-257)], [1, 2]);
  assert.deepEqual(decoded.get('list'), [true, false, null, 70000]);

  const bad = {
    truncated: cbor(value).subarray(0, 10),
    'long length': Buffer.from([0x5a, 0xff, 0xff, 0xff, 0xff, 0x00]),
    indefinite: Buffer.from([0x5f, 0x41, 0x00, 0xff]),
    tag: Buffer.from([0xc2, 0x41, 0x01]),
    float: Buffer.from([0xf9, 0x3c, 0x00]),
    undefined: Buffer.from([0xf7]),
    'duplicate key': Buffer.from([0xa2, 0x01, 0x01, 0x01, 0x02]),
    'too deep': Buffer.from([...Array(12).fill(0x81), 0x01]),
    'bad utf-8': Buffer.from([0x62, 0xc3, 0x28]),
  };
  for (const [name, bytes] of Object.entries(bad)) assert.throws(() => decodeCbor(bytes), /CBOR|UTF-8/, name);
});

test('DER signatures become fixed-size r‖s', () => {
  // r 带前导 0（最高位是 1），s 只有 31 字节。
  const r = [0x00, 0x80, ...Array(31).fill(0x11)];
  const s = Array(31).fill(0x22);
  const der = Buffer.from([0x30, 4 + r.length + s.length, 0x02, r.length, ...r, 0x02, s.length, ...s]);
  const raw = derToRaw(der);
  assert.equal(raw.length, 64);
  assert.deepEqual([...raw.subarray(0, 32)], [0x80, ...Array(31).fill(0x11)]);
  assert.deepEqual([...raw.subarray(32)], [0, ...Array(31).fill(0x22)]);

  for (const bad of [
    Buffer.from([0x31, 6, 2, 1, 1, 2, 1, 1]),
    Buffer.from([0x30, 7, 2, 1, 1, 2, 1, 1]),
    Buffer.from([0x30, 6, 2, 1, 1, 2, 1, 1, 0]),
    Buffer.from([0x30, 6, 2, 0, 2, 2, 1, 1]),
    Buffer.from([0x30, 37, 2, 33, ...Array(33).fill(0x7f), 2, 0]),
  ]) {
    assert.throws(() => derToRaw(bad), /ECDSA/);
  }
});

test('registration rejects malformed authenticator data', async () => {
  const device = authenticator();
  const register = (overrides) => {
    const value = options();
    return verifyRegistration(device.register(value, overrides), { ...expected, challenge: value.challenge });
  };
  const ok = await register({ transports: ['internal', 'hybrid', 'carrier-pigeon'] });
  assert.equal(ok.algorithm, -7);
  assert.deepEqual(ok.transports, ['internal', 'hybrid']);
  assert.equal(ok.aaguid, 'fbfc3007-154e-4ecc-8c0b-6e020557d7bd');

  // 别家的证明格式不验证，照常接受。
  assert.equal((await register({ fmt: 'packed', attStmt: new Map([['alg', -7], ['sig', new Uint8Array(8)]]) })).id, device.id);

  const cases = {
    '备份标志不一致': { flags: 0x01 | 0x04 | 0x10 | 0x40 },
    '缺少凭据数据': { flags: 0x01 | 0x04 },
    '用户不在场': { flags: 0x04 | 0x40 },
    '多余的数据': { extra: Buffer.from([0]) },
    'attestationObject 后面': { trailing: Buffer.from([0]) },
    '凭据 id 不一致': { id: 'AAAAAAAAAAAAAAAAAAAAAA' },
    '不支持的签名算法 -35': { key: [[1, 2], [3, -35], [-1, 2], [-2, new Uint8Array(48)], [-3, new Uint8Array(48)]] },
    '不支持的公钥': { key: [[1, 2], [3, -7], [-1, 1], [-2, new Uint8Array(31)], [-3, new Uint8Array(32)]] },
    '公钥无效': { key: [[1, 2], [3, -7], [-1, 1], [-2, new Uint8Array(32)], [-3, new Uint8Array(32)]] },
  };
  for (const [message, overrides] of Object.entries(cases)) await assert.rejects(register(overrides), new RegExp(message), message);
  await assert.rejects(verifyRegistration({ type: 'public-key', response: 'x' }, expected), /不是公钥凭据/);
  await assert.rejects(verifyRegistration({ ...device.register(options()), type: 'password' }, expected), /不是公钥凭据/);
  const value = options();
  const response = device.register(value);
  await assert.rejects(verifyRegistration(response, { ...expected, challenge: newChallenge() }), /challenge/);
  response.response.clientDataJSON = Buffer.from(JSON.stringify({ type: 'webauthn.create', challenge: value.challenge, origin: expected.origin, crossOrigin: true })).toString('base64url');
  await assert.rejects(verifyRegistration(response, { ...expected, challenge: value.challenge }), /别的网站/);
  response.response.clientDataJSON = 'not+base64';
  await assert.rejects(verifyRegistration(response, { ...expected, challenge: value.challenge }), /base64url/);
});
