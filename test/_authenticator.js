import { createHash, generateKeyPairSync, randomBytes, sign } from 'node:crypto';

// 测试用的软件认证器：ES256/Ed25519/RS256 密钥、none 证明，按 WebAuthn 规范拼出 authenticatorData 和签名，
// 产出和浏览器里 @simplewebauthn/browser 一样的 JSON。
const UP = 0x01;
const UV = 0x04;
const BE = 0x08;
const BS = 0x10;
const AT = 0x40;
export const ICLOUD_AAGUID = 'fbfc3007-154e-4ecc-8c0b-6e020557d7bd';

const b64 = (bytes) => Buffer.from(bytes).toString('base64url');
const sha256 = (data) => createHash('sha256').update(data).digest();

// 只实现用得到的 CBOR：整数、字节串、文本、数组、Map 和 true/false/null，长度一律取最短编码（CTAP2 的规范编码）。
function head(major, length) {
  if (length < 24) return Buffer.from([(major << 5) | length]);
  if (length < 0x100) return Buffer.from([(major << 5) | 24, length]);
  if (length < 0x10000) return Buffer.from([(major << 5) | 25, length >> 8, length & 0xff]);
  const out = Buffer.alloc(5);
  out[0] = (major << 5) | 26;
  out.writeUInt32BE(length, 1);
  return out;
}

export function cbor(value) {
  if (typeof value === 'number') return value >= 0 ? head(0, value) : head(1, -1 - value);
  if (typeof value === 'string') return Buffer.concat([head(3, Buffer.byteLength(value)), Buffer.from(value)]);
  if (value instanceof Uint8Array) return Buffer.concat([head(2, value.length), value]);
  if (typeof value === 'boolean' || value === null) return Buffer.from([value === null ? 0xf6 : value ? 0xf5 : 0xf4]);
  if (Array.isArray(value)) return Buffer.concat([head(4, value.length), ...value.map(cbor)]);
  if (value instanceof Map) return Buffer.concat([head(5, value.size), ...[...value].flatMap(([key, item]) => [cbor(key), cbor(item)])]);
  throw new TypeError(`cbor: unsupported value ${value}`);
}

// 三种公钥：ES256（多数通行密钥）、Ed25519（部分安全密钥）、RS256（Windows Hello）。
const KEYS = {
  es256: () => {
    const pair = generateKeyPairSync('ec', { namedCurve: 'P-256' });
    const jwk = pair.publicKey.export({ format: 'jwk' });
    return { pair, hash: 'sha256', cose: [[1, 2], [3, -7], [-1, 1], [-2, Buffer.from(jwk.x, 'base64url')], [-3, Buffer.from(jwk.y, 'base64url')]] };
  },
  ed25519: () => {
    const pair = generateKeyPairSync('ed25519');
    const jwk = pair.publicKey.export({ format: 'jwk' });
    return { pair, hash: null, cose: [[1, 1], [3, -8], [-1, 6], [-2, Buffer.from(jwk.x, 'base64url')]] };
  },
  rs256: () => {
    const pair = generateKeyPairSync('rsa', { modulusLength: 2048 });
    const jwk = pair.publicKey.export({ format: 'jwk' });
    return { pair, hash: 'sha256', cose: [[1, 3], [3, -257], [-1, Buffer.from(jwk.n, 'base64url')], [-2, Buffer.from(jwk.e, 'base64url')]] };
  },
};

// step：每次签名计数器加多少。同步的通行密钥一直报 0。
export function authenticator({ origin = 'https://lucius7.dev', aaguid = ICLOUD_AAGUID, synced = true, key = 'es256', step = 0 } = {}) {
  const { pair, hash, cose } = KEYS[key]();
  const rawId = randomBytes(16);
  const id = b64(rawId);
  let counter = 0;

  // overrides 用来造坏数据：flags 直接指定标志位，key 换公钥，extra 在末尾多塞字节。
  function authData(rpID, { uv = true, attested = false, count = counter, flags, key: coseKey = cose, extra } = {}) {
    flags ??= UP | (uv ? UV : 0) | (synced ? BE | BS : 0) | (attested ? AT : 0);
    const signCount = Buffer.alloc(4);
    signCount.writeUInt32BE(count);
    const parts = [sha256(rpID), Buffer.from([flags]), signCount];
    if (attested) {
      const credentialId = Buffer.alloc(2);
      credentialId.writeUInt16BE(rawId.length);
      parts.push(Buffer.from(aaguid.replace(/-/g, ''), 'hex'), credentialId, rawId, cbor(new Map(coseKey)));
    }
    if (extra) parts.push(extra);
    return Buffer.concat(parts);
  }

  function clientData(type, challenge, overrides) {
    return Buffer.from(JSON.stringify({ type, challenge, origin: overrides.origin ?? origin, crossOrigin: false }));
  }

  return {
    id,
    // options 是 /api/v1/me/passkeys/options 返回的登记参数。
    register(options, overrides = {}) {
      const data = authData(overrides.rpID ?? options.rp.id, { uv: overrides.uv ?? true, attested: true, flags: overrides.flags, key: overrides.key, extra: overrides.extra });
      const attestationObject = Buffer.concat([cbor(new Map([['fmt', overrides.fmt ?? 'none'], ['attStmt', overrides.attStmt ?? new Map()], ['authData', data]])), overrides.trailing ?? Buffer.alloc(0)]);
      return {
        id: overrides.id ?? id,
        rawId: overrides.id ?? id,
        type: 'public-key',
        response: {
          clientDataJSON: b64(clientData('webauthn.create', options.challenge, overrides)),
          attestationObject: b64(attestationObject),
          transports: overrides.transports ?? ['hybrid', 'internal'],
        },
        clientExtensionResults: {},
        authenticatorAttachment: 'platform',
      };
    },
    // options 是 /api/v1/auth/passkey/options 返回的登录参数。
    login(options, overrides = {}) {
      counter += step;
      const data = authData(overrides.rpID ?? options.rpId, { uv: overrides.uv ?? true, count: overrides.counter ?? counter });
      const client = clientData('webauthn.get', overrides.challenge ?? options.challenge, overrides);
      // Node 对 EC 密钥默认输出 DER 编码的签名，正是 WebAuthn 要求的格式；RSA 默认是 PKCS#1 v1.5。
      const signature = sign(hash, Buffer.concat([data, sha256(client)]), pair.privateKey);
      return {
        id,
        rawId: id,
        type: 'public-key',
        response: {
          clientDataJSON: b64(client),
          authenticatorData: b64(data),
          signature: b64(overrides.signature ?? signature),
          userHandle: b64(Buffer.from('xw7-owner')),
        },
        clientExtensionResults: {},
        authenticatorAttachment: 'platform',
      };
    },
  };
}
