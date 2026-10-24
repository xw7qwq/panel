import { base64url, fromBase64url } from './auth.js';

// 通行密钥（WebAuthn）的服务端校验，只做面板用得到的部分，按规范 §7.1（登记）和 §7.2（登录）逐项检查。
// 不验证证明（attestation 按 none 处理：不关心是哪家的认证器），只接受 Ed25519、ES256、RS256 三种公钥。
// 现成的服务端库连带几百 KB 的 ASN.1/X.509 代码，冷启动就超过免费版每次请求 10 ms 的 CPU 限额。
export const ALGORITHMS = [-8, -7, -257];
const TRANSPORTS = ['ble', 'cable', 'hybrid', 'internal', 'nfc', 'smart-card', 'usb'];
const UP = 0x01;
const UV = 0x04;
const BE = 0x08;
const BS = 0x10;
const AT = 0x40;
const ED = 0x80;
const encoder = new TextEncoder();

const KEY_TYPES = {
  [-7]: { importParams: { name: 'ECDSA', namedCurve: 'P-256' }, verifyParams: { name: 'ECDSA', hash: 'SHA-256' } },
  [-8]: { importParams: { name: 'Ed25519' }, verifyParams: { name: 'Ed25519' } },
  [-257]: { importParams: { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, verifyParams: { name: 'RSASSA-PKCS1-v1_5' } },
};

export class WebAuthnError extends Error {}

function reject(message) {
  throw new WebAuthnError(message);
}

export function newChallenge() {
  return base64url(crypto.getRandomValues(new Uint8Array(32)));
}

export function registrationOptions({ challenge, rpName, rpID, userID, userName, userDisplayName, timeout, exclude = [] }) {
  return {
    challenge,
    rp: { name: rpName, id: rpID },
    user: { id: base64url(userID), name: userName, displayName: userDisplayName },
    pubKeyCredParams: ALGORITHMS.map((alg) => ({ type: 'public-key', alg })),
    timeout,
    attestation: 'none',
    excludeCredentials: exclude.map(({ id, transports }) => ({ type: 'public-key', id, ...(transports?.length ? { transports } : {}) })),
    authenticatorSelection: { residentKey: 'required', requireResidentKey: true, userVerification: 'required' },
    extensions: { credProps: true },
  };
}

// 不列出凭据，由浏览器或密码管理器自己找这个站点的通行密钥。
export function authenticationOptions({ challenge, rpID, timeout }) {
  return { challenge, rpId: rpID, timeout, userVerification: 'required' };
}

function bytes(value, label) {
  if (typeof value !== 'string' || !/^[\w-]+$/.test(value)) reject(`${label} 不是 base64url`);
  try {
    return fromBase64url(value);
  } catch {
    return reject(`${label} 不是 base64url`);
  }
}

function text(chunk) {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(chunk);
  } catch {
    return reject('文本不是合法的 UTF-8');
  }
}

async function sha256(data) {
  return new Uint8Array(await crypto.subtle.digest('SHA-256', data));
}

function sameBytes(a, b) {
  return a.length === b.length && a.every((value, index) => value === b[index]);
}

function checkClientData(encoded, type, expected) {
  let data;
  try {
    data = JSON.parse(text(encoded));
  } catch {
    reject('clientDataJSON 无法解析');
  }
  if (data?.type !== type) reject(`clientData.type 应为 ${type}`);
  if (data.challenge !== expected.challenge) reject('challenge 不匹配');
  if (data.origin !== expected.origin) reject(`origin 不匹配：${String(data.origin).slice(0, 100)}`);
  if (data.crossOrigin === true || data.topOrigin !== undefined) reject('不接受嵌在别的网站里发起的请求');
}

// authenticatorData 的固定部分：rpIdHash(32) ‖ flags(1) ‖ signCount(4)。
async function checkAuthData(data, rpID) {
  if (data.length < 37) reject('authenticatorData 太短');
  if (!sameBytes(data.subarray(0, 32), await sha256(encoder.encode(rpID)))) reject('rpIdHash 不匹配');
  const flags = data[32];
  if (!(flags & UP)) reject('用户不在场');
  if (!(flags & UV)) reject('没有验证用户');
  if (flags & BS && !(flags & BE)) reject('备份标志不一致');
  return { flags, counter: new DataView(data.buffer, data.byteOffset + 33, 4).getUint32(0), backedUp: Boolean(flags & BS), multiDevice: Boolean(flags & BE) };
}

// 只解码 WebAuthn 用得到的 CBOR：整数、字节串、文本、数组、Map 和 true/false/null。不支持不定长、标签和浮点。
export function decodeCbor(data, offset = 0, depth = 0) {
  if (depth > 8) reject('CBOR 嵌套太深');
  const need = (count) => (offset + count <= data.length ? undefined : reject('CBOR 数据不完整'));
  need(1);
  const initial = data[offset++];
  const major = initial >> 5;
  const info = initial & 0x1f;
  let length = info;
  if (info >= 24) {
    if (info > 27) reject('不支持不定长的 CBOR');
    const size = 1 << (info - 24);
    need(size);
    const view = new DataView(data.buffer, data.byteOffset + offset, size);
    length = size === 1 ? view.getUint8(0) : size === 2 ? view.getUint16(0) : size === 4 ? view.getUint32(0) : Number(view.getBigUint64(0));
    if (!Number.isSafeInteger(length)) reject('CBOR 整数太大');
    offset += size;
  }
  if (major === 0) return { value: length, end: offset };
  if (major === 1) return { value: -1 - length, end: offset };
  if (major === 2 || major === 3) {
    need(length);
    const chunk = data.subarray(offset, offset + length);
    return { value: major === 2 ? chunk : text(chunk), end: offset + length };
  }
  if (major === 4 || major === 5) {
    const items = major === 4 ? [] : new Map();
    for (let index = 0; index < length; index++) {
      const key = decodeCbor(data, offset, depth + 1);
      offset = key.end;
      if (major === 4) {
        items.push(key.value);
        continue;
      }
      const item = decodeCbor(data, offset, depth + 1);
      offset = item.end;
      if (items.has(key.value)) reject('CBOR Map 有重复的键');
      items.set(key.value, item.value);
    }
    return { value: items, end: offset };
  }
  if (major === 7 && info >= 20 && info <= 22) return { value: [false, true, null][info - 20], end: offset };
  return reject('不支持的 CBOR 类型');
}

// COSE 公钥转成 WebCrypto 能直接导入的 JWK。
function coseToJwk(cose) {
  if (!(cose instanceof Map)) reject('公钥不是 COSE Map');
  const [kty, alg, a, b, c] = [1, 3, -1, -2, -3].map((key) => cose.get(key));
  const isBytes = (value, size) => value instanceof Uint8Array && (size === undefined || value.length === size);
  if (alg === -7 && kty === 2 && a === 1 && isBytes(b, 32) && isBytes(c, 32)) return { kty: 'EC', crv: 'P-256', x: base64url(b), y: base64url(c) };
  if (alg === -8 && kty === 1 && a === 6 && isBytes(b, 32)) return { kty: 'OKP', crv: 'Ed25519', x: base64url(b) };
  if (alg === -257 && kty === 3 && isBytes(a) && a.length >= 256 && isBytes(b)) return { kty: 'RSA', n: base64url(a), e: base64url(b) };
  return reject(`不支持的公钥（alg ${alg}）`);
}

function importKey(algorithm, jwk) {
  return crypto.subtle.importKey('jwk', jwk, KEY_TYPES[algorithm].importParams, false, ['verify']);
}

// ECDSA 签名在 WebAuthn 里是 DER 编码的 SEQUENCE { r INTEGER, s INTEGER }，WebCrypto 要的是定长的 r‖s。
export function derToRaw(der, size = 32) {
  const malformed = () => reject('ECDSA 签名格式不对');
  if (der.length < 8 || der[0] !== 0x30 || der[1] !== der.length - 2) malformed();
  const raw = new Uint8Array(size * 2);
  let offset = 2;
  for (let part = 1; part <= 2; part++) {
    if (der[offset] !== 0x02) malformed();
    const length = der[offset + 1];
    let value = der.subarray(offset + 2, offset + 2 + length);
    if (!length || value.length !== length) malformed();
    offset += 2 + length;
    while (value.length > 1 && value[0] === 0) value = value.subarray(1);
    if (value.length > size) malformed();
    raw.set(value, size * part - value.length);
  }
  if (offset !== der.length) malformed();
  return raw;
}

// 登记：返回要保存的凭据。expected = { challenge, origin, rpID }。
export async function verifyRegistration(credential, expected) {
  const response = credential?.response;
  if (credential?.type !== 'public-key' || typeof response !== 'object' || !response) reject('不是公钥凭据');
  checkClientData(bytes(response.clientDataJSON, 'clientDataJSON'), 'webauthn.create', expected);
  const encoded = bytes(response.attestationObject, 'attestationObject');
  const attestation = decodeCbor(encoded);
  if (attestation.end !== encoded.length) reject('attestationObject 后面有多余的数据');
  const object = attestation.value;
  const data = object instanceof Map ? object.get('authData') : null;
  if (!(data instanceof Uint8Array) || typeof object.get('fmt') !== 'string') reject('attestationObject 格式不对');
  const info = await checkAuthData(data, expected.rpID);
  if (!(info.flags & AT) || data.length < 55) reject('缺少凭据数据');
  const aaguid = [...data.subarray(37, 53)].map((byte) => byte.toString(16).padStart(2, '0')).join('').replace(/^(.{8})(.{4})(.{4})(.{4})/, '$1-$2-$3-$4-');
  const idLength = (data[53] << 8) | data[54];
  if (!idLength || idLength > 1023 || 55 + idLength > data.length) reject('凭据 id 长度不对');
  const id = base64url(data.subarray(55, 55 + idLength));
  if (credential.id !== id || credential.rawId !== id) reject('凭据 id 不一致');
  const key = decodeCbor(data, 55 + idLength);
  if (!(info.flags & ED) && key.end !== data.length) reject('authenticatorData 后面有多余的数据');
  const algorithm = key.value instanceof Map ? key.value.get(3) : undefined;
  if (!ALGORITHMS.includes(algorithm)) reject(`不支持的签名算法 ${algorithm}`);
  const publicKey = coseToJwk(key.value);
  await importKey(algorithm, publicKey).catch(() => reject('公钥无效'));
  const transports = Array.isArray(response.transports) ? response.transports.filter((item) => TRANSPORTS.includes(item)) : [];
  return { id, publicKey, algorithm, counter: info.counter, aaguid, backedUp: info.backedUp, multiDevice: info.multiDevice, transports };
}

// 登录：stored 是登记时保存的 { id, public_key, algorithm, counter }，返回新的计数器和备份状态。
export async function verifyAuthentication(credential, stored, expected) {
  const response = credential?.response;
  if (credential?.type !== 'public-key' || typeof response !== 'object' || !response) reject('不是公钥凭据');
  if (credential.id !== stored.id || credential.rawId !== stored.id) reject('凭据 id 不一致');
  const clientData = bytes(response.clientDataJSON, 'clientDataJSON');
  checkClientData(clientData, 'webauthn.get', expected);
  const data = bytes(response.authenticatorData, 'authenticatorData');
  const info = await checkAuthData(data, expected.rpID);
  let signature = bytes(response.signature, 'signature');
  if (stored.algorithm === -7) signature = derToRaw(signature);
  const signed = new Uint8Array(data.length + 32);
  signed.set(data);
  signed.set(await sha256(clientData), data.length);
  const key = await importKey(stored.algorithm, stored.public_key);
  if (!(await crypto.subtle.verify(KEY_TYPES[stored.algorithm].verifyParams, key, signature, signed))) reject('签名不对');
  // 同步的通行密钥计数器一直是 0；有一方不是 0 时必须递增，否则可能是被复制的认证器。
  if ((info.counter > 0 || stored.counter > 0) && info.counter <= stored.counter) reject('签名计数器没有递增');
  return { counter: info.counter, backedUp: info.backedUp };
}
