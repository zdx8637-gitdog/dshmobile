// E2EE v1 crypto 原语（bridge/Node 侧）。字节格式与 docs/plan-e2ee.md 一一对应。
// 注意：所有 AAD/connCtx/pairingCtx 都是「固定顺序 + 长度前缀」的二进制拼接，禁止 JSON，
// 以保证 Node 与 Android 逐字节一致。
import {
  createCipheriv,
  createDecipheriv,
  createHash,
  createHmac,
  createPrivateKey,
  createPublicKey,
  diffieHellman,
  generateKeyPairSync,
  randomBytes,
} from "node:crypto";

// X25519 原始 32B 密钥与 ASN.1 DER 之间的固定头（RFC 8410）
const SPKI_PREFIX = Buffer.from("302a300506032b656e032100", "hex"); // 12B 前缀
const PKCS8_PREFIX = Buffer.from("302e020100300506032b656e04220420", "hex"); // 16B 前缀

// ---- 编解码 ----
export function toB64url(buf) {
  return buf.toString("base64url");
}
export function fromB64url(s) {
  return Buffer.from(s, "base64url");
}

function u8(n) {
  return Buffer.from([n & 0xff]);
}
function u16be(n) {
  const b = Buffer.alloc(2);
  b.writeUInt16BE(n, 0);
  return b;
}
function u64be(n) {
  const b = Buffer.alloc(8);
  b.writeBigUInt64BE(BigInt(n), 0);
  return b;
}
/** u16 长度前缀 + UTF-8 字符串 */
function u16str(s) {
  const buf = Buffer.from(s, "utf8");
  return Buffer.concat([u16be(buf.length), buf]);
}
/** u16 长度前缀 + 原始字节 */
function u16buf(buf) {
  return Buffer.concat([u16be(buf.length), buf]);
}

// ---- X25519 原始密钥 <-> KeyObject ----
function rawPubToKey(raw) {
  return createPublicKey({ key: Buffer.concat([SPKI_PREFIX, raw]), format: "der", type: "spki" });
}
function rawPrivToKey(raw) {
  return createPrivateKey({ key: Buffer.concat([PKCS8_PREFIX, raw]), format: "der", type: "pkcs8" });
}
function keyToRawPub(key) {
  return key.export({ format: "der", type: "spki" }).subarray(SPKI_PREFIX.length);
}
function keyToRawPriv(key) {
  return key.export({ format: "der", type: "pkcs8" }).subarray(PKCS8_PREFIX.length);
}

// ---- 身份密钥 ----
/** 生成长期 X25519 身份密钥对。返回 b64url 公钥/私钥 + 8B keyId（hex）。 */
export function generateIdentityKeypair() {
  const { publicKey, privateKey } = generateKeyPairSync("x25519");
  const pub = keyToRawPub(publicKey);
  const priv = keyToRawPriv(privateKey);
  return { pubKey: toB64url(pub), privKey: toB64url(priv), keyId: keyIdOf(pub) };
}

/** keyId = hex(sha256(pubkey))[0:8]，返回 16 位 hex 字符串。 */
export function keyIdOf(rawPub) {
  return createHash("sha256").update(rawPub).digest().subarray(0, 8).toString("hex");
}

/** keyId hex(16 字符) -> 8B 原始。 */
export function keyIdBytes(keyIdHex) {
  return Buffer.from(keyIdHex, "hex");
}

// ---- 静态 DH ----
/** X25519 静态共享 secret（32B Buffer）。入参为 b64url 私钥/公钥。 */
export function computeSharedSecret(privB64url, peerPubB64url) {
  const priv = rawPrivToKey(fromB64url(privB64url));
  const pub = rawPubToKey(fromB64url(peerPubB64url));
  return diffieHellman({ privateKey: priv, publicKey: pub });
}

// ---- HKDF-SHA256（RFC 5869）----
export function hkdfSha256(ikm, salt, info, length = 32) {
  const prk = createHmac("sha256", salt).update(ikm).digest();
  const okm = Buffer.alloc(length);
  let t = Buffer.alloc(0);
  let i = 1;
  let off = 0;
  while (off < length) {
    t = createHmac("sha256", prk).update(Buffer.concat([t, info, u8(i)])).digest();
    const n = Math.min(t.length, length - off);
    t.copy(okm, off, 0, n);
    off += n;
    i += 1;
  }
  return okm;
}

// ---- 每连接密钥派生 ----
/** connCtx（两端必须逐字节一致；keyId/cNonce 按角色固定顺序：phone 前、bridge 后）。 */
export function connectionContext({ keyIdPhoneHex, keyIdBridgeHex, cNoncePhoneB64url, cNonceBridgeB64url }) {
  return Buffer.concat([
    Buffer.from("dshmobile-e2ee-v1", "utf8"),
    u8(1),
    keyIdBytes(keyIdPhoneHex), // 8B
    keyIdBytes(keyIdBridgeHex), // 8B
    fromB64url(cNoncePhoneB64url), // 16B
    fromB64url(cNonceBridgeB64url), // 16B
  ]);
}

/** 从 master secret + connCtx 派生本连接双向控制面密钥。 */
export function deriveConnectionKeys(ms, connCtx) {
  const salt = Buffer.from("dshmobile-e2ee-conn", "utf8");
  return {
    p2b: hkdfSha256(ms, salt, Buffer.concat([connCtx, Buffer.from("control:phone->bridge", "utf8")]), 32),
    b2p: hkdfSha256(ms, salt, Buffer.concat([connCtx, Buffer.from("control:bridge->phone", "utf8")]), 32),
  };
}

// ---- 配对认证 ----
/** 配对认证密钥 K_ps = HKDF(ps, salt="dshmobile-e2ee-pairing", info="pairing-auth")。 */
export function pairingAuthKey(psB64url) {
  return hkdfSha256(
    fromB64url(psB64url),
    Buffer.from("dshmobile-e2ee-pairing", "utf8"),
    Buffer.from("pairing-auth", "utf8"),
    32,
  );
}

/** pairingCtx：绑定 cryptoVersion + pairingId + deviceId + 双公钥(32B raw) + role。 */
export function pairingContext({ pairingId, deviceId, bridgePubRaw, phonePubRaw, role }) {
  return Buffer.concat([
    Buffer.from("dshmobile-e2ee-pairing-v1", "utf8"),
    u8(1),
    u16str(pairingId),
    u16str(deviceId),
    u16buf(bridgePubRaw),
    u16buf(phonePubRaw),
    u16str(role),
  ]);
}

/** 配对 auth 标签 = HMAC-SHA256(K_ps, pairingCtx)。 */
export function pairingAuth(kps, pairingCtx) {
  return createHmac("sha256", kps).update(pairingCtx).digest();
}

// ---- AAD / meta canonical ----
/** meta 对象 -> 字节：键字典序，每个键值 u16(len)||key||u16(len)||valueStr。 */
export function canonicalMeta(meta = {}) {
  const parts = [];
  for (const k of Object.keys(meta).sort()) {
    const v = meta[k];
    const vStr = typeof v === "string" ? v : v === undefined || v === null ? "" : String(v);
    parts.push(u16str(k));
    parts.push(u16str(vStr));
  }
  return Buffer.concat(parts);
}

/** AAD：固定顺序 + 长度前缀二进制（keyId 用 8B raw）。 */
export function canonicalAAD({ type, requestId, targetDeviceId, keyIdHex, version, dir, seq, meta }) {
  const metaBytes = canonicalMeta(meta);
  return Buffer.concat([
    Buffer.from("dshmobile-e2ee-aad-v1", "utf8"),
    u16str(type),
    u16str(requestId),
    u16str(targetDeviceId),
    keyIdBytes(keyIdHex), // 8B raw
    u8(version),
    u8(dir),
    u64be(seq),
    u16buf(metaBytes),
  ]);
}

// ---- AEAD ----
/** nonce = 0x00*4 || seq(8B BE)，12B。 */
export function nonceFor(dir, seq) {
  return Buffer.concat([Buffer.from([0, 0, 0, dir]), u64be(seq)]);
}

/** AES-256-GCM 加密，返回 ciphertext||tag。 */
export function aeadEncrypt(key, nonce, aad, plaintext) {
  const cipher = createCipheriv("aes-256-gcm", key, nonce);
  cipher.setAAD(aad);
  const ct = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  return Buffer.concat([ct, cipher.getAuthTag()]);
}

/** AES-256-GCM 解密（ctTag = ciphertext||tag），tag 校验失败抛错。 */
export function aeadDecrypt(key, nonce, aad, ctTag) {
  const ct = ctTag.subarray(0, -16);
  const tag = ctTag.subarray(-16);
  const decipher = createDecipheriv("aes-256-gcm", key, nonce);
  decipher.setAAD(aad);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ct), decipher.final()]);
}

// ---- 便捷封装：一条控制面消息的加解密 ----
/** dir 编码：p2b=1, b2p=2。 */
export const DIR = { p2b: 1, b2p: 2 };

/** 加密一条控制面 payload。返回 { enc, ct }（ct 为 b64url ciphertext||tag）。 */
export function encryptPayload({ key, dir, seq, aad, plaintext }) {
  const nonce = nonceFor(dir, seq);
  const ctTag = aeadEncrypt(key, nonce, aad, Buffer.from(plaintext, "utf8"));
  return { enc: "aes-256-gcm", ct: toB64url(ctTag) };
}

/** 解密一条控制面 payload，返回 UTF-8 明文字符串。 */
export function decryptPayload({ key, dir, seq, aad, ctB64url }) {
  const nonce = nonceFor(dir, seq);
  const plain = aeadDecrypt(key, nonce, aad, fromB64url(ctB64url));
  return plain.toString("utf8");
}

/** 生成 16B 随机连接 nonce（b64url）。 */
export function randomConnectionNonce() {
  return toB64url(randomBytes(16));
}

/** 生成 32B 随机配对 secret（b64url）。 */
export function randomPairingSecret() {
  return toB64url(randomBytes(32));
}
