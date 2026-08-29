// E2EE crypto 原语自测：RFC 7748 / RFC 5869 已知向量 + 全链路 roundtrip + 跨平台 golden vectors。
// 用法：node scripts/crypto-vectors.mjs
import assert from "node:assert";
import {
  generateIdentityKeypair, keyIdOf, computeSharedSecret, hkdfSha256,
  connectionContext, deriveConnectionKeys, pairingAuthKey, pairingContext, pairingAuth,
  canonicalMeta, canonicalAAD, aeadEncrypt, aeadDecrypt, encryptPayload, decryptPayload,
  nonceFor, toB64url, fromB64url, DIR,
} from "../bridge/crypto.js";

const hex = (s) => Buffer.from(s, "hex");
const b64 = (s) => toB64url(hex(s));
let pass = 0;

// 1) X25519 RFC 7748 §6.1（Alice/Bob）
{
  const alicePriv = b64("77076d0a7318a57d3c16c17251b26645df4c2f87ebc0992ab177fba51db92c2a");
  const alicePub = b64("8520f0098930a754748b7ddcb43ef75a0dbf3a0d26381af4eba4a98eaa9b4e6a");
  const bobPriv = b64("5dab087e624a8a4b79e17f8b83800ee66f3bb1292618b6fd1c2f8b27ff88e0eb");
  const bobPub = b64("de9edb7d7b7dc1b4d35b61c2ece435373f8343c85b78674dadfc7e146f882b4f");
  const ss = computeSharedSecret(alicePriv, bobPub);
  assert.strictEqual(ss.toString("hex"), "4a5d9d5ba4ce2de1728e3bf480350f25e07e21c947d19e3376f09b3c1e161742");
  pass += 1;
  console.log("✓ X25519 RFC 7748");
}

// 2) HKDF-SHA256 RFC 5869 Test Case 1
{
  const ikm = Buffer.alloc(22, 0x0b);
  const salt = hex("000102030405060708090a0b0c");
  const info = hex("f0f1f2f3f4f5f6f7f8f9");
  const okm = hkdfSha256(ikm, salt, info, 42);
  assert.strictEqual(okm.toString("hex"), "3cb25f25faacd57a90434f64d0362f2a2d2d0a90cf1a5a4c5db02d56ecc4c5bf34007208d5b887185865");
  pass += 1;
  console.log("✓ HKDF-SHA256 RFC 5869 TC1");
}

// 3) 全链路：两端身份密钥 → 相同 MS → 相同 connCtx → 相同双向 key → 加密往返
{
  const phone = generateIdentityKeypair();
  const bridge = generateIdentityKeypair();

  // 两端各自算 MS，应一致
  const msPhone = computeSharedSecret(phone.privKey, bridge.pubKey);
  const msBridge = computeSharedSecret(bridge.privKey, phone.pubKey);
  assert.deepStrictEqual(msPhone, msBridge);

  const cNoncePhone = toB64url(hex("00000000000000000000000000000001"));
  const cNonceBridge = toB64url(hex("00000000000000000000000000000002"));
  const ctx = connectionContext({
    keyIdPhoneHex: phone.keyId, keyIdBridgeHex: bridge.keyId,
    cNoncePhoneB64url: cNoncePhone, cNonceBridgeB64url: cNonceBridge,
  });
  const keysPhone = deriveConnectionKeys(msPhone, ctx);
  const keysBridge = deriveConnectionKeys(msBridge, ctx);
  assert.deepStrictEqual(keysPhone.p2b, keysBridge.p2b);
  assert.deepStrictEqual(keysPhone.b2p, keysBridge.b2p);

  const meta = { subscriptionId: "s-1", sequence: 7, now: "2026-08-23T00:00:00.000Z" };
  const aad = canonicalAAD({
    type: "sessions.run", requestId: "req-1", targetDeviceId: "dev-1",
    keyIdHex: phone.keyId, version: 1, dir: DIR.p2b, seq: 1, meta,
  });
  const { ct } = encryptPayload({ key: keysPhone.p2b, dir: DIR.p2b, seq: 1, aad, plaintext: "hello e2ee" });
  const plain = decryptPayload({ key: keysBridge.p2b, dir: DIR.p2b, seq: 1, aad, ctB64url: ct });
  assert.strictEqual(plain, "hello e2ee");
  pass += 1;
  console.log("✓ 全链路 roundtrip（两端 MS/key 一致 + 加解密）");
}

// 4) AAD 篡改 → 解密失败（tag 校验）
{
  const phone = generateIdentityKeypair();
  const bridge = generateIdentityKeypair();
  const ms = computeSharedSecret(phone.privKey, bridge.pubKey);
  const ctx = connectionContext({
    keyIdPhoneHex: phone.keyId, keyIdBridgeHex: bridge.keyId,
    cNoncePhoneB64url: toB64url(hex("00000000000000000000000000000003")),
    cNonceBridgeB64url: toB64url(hex("00000000000000000000000000000004")),
  });
  const keys = deriveConnectionKeys(ms, ctx);
  const goodAad = canonicalAAD({ type: "x", requestId: "r", targetDeviceId: "d", keyIdHex: phone.keyId, version: 1, dir: DIR.p2b, seq: 1, meta: {} });
  const badAad = canonicalAAD({ type: "y", requestId: "r", targetDeviceId: "d", keyIdHex: phone.keyId, version: 1, dir: DIR.p2b, seq: 1, meta: {} });
  const { ct } = encryptPayload({ key: keys.p2b, dir: DIR.p2b, seq: 1, aad: goodAad, plaintext: "tamper test" });
  assert.throws(() => decryptPayload({ key: keys.p2b, dir: DIR.p2b, seq: 1, aad: badAad, ctB64url: ct }));
  pass += 1;
  console.log("✓ AAD 篡改被 tag 校验拒绝");
}

// 5) 配对 auth：auth 随上下文变化
{
  const ps = toB64url(hex("deadbeef".repeat(8)));
  const kps = pairingAuthKey(ps);
  const bridgePub = fromB64url(generateIdentityKeypair().pubKey);
  const phonePub = fromB64url(generateIdentityKeypair().pubKey);
  const ctx1 = pairingContext({ pairingId: "p1", deviceId: "d1", bridgePubRaw: bridgePub, phonePubRaw: phonePub, role: "phone" });
  const ctx2 = pairingContext({ pairingId: "p2", deviceId: "d1", bridgePubRaw: bridgePub, phonePubRaw: phonePub, role: "phone" });
  assert.notDeepStrictEqual(pairingAuth(kps, ctx1), pairingAuth(kps, ctx2));
  pass += 1;
  console.log("✓ 配对 auth 绑定上下文（不同 pairingId 得不同 tag）");
}

console.log(`\nALL PASS (${pass}/5)`);
