// E2eeSession（bridge 侧）单测：配对 + pin + 连接密钥 + 加解密 + replay。
import assert from "node:assert";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { E2eeSession } from "../bridge/e2ee.js";
import * as c from "../bridge/crypto.js";

const dir = mkdtempSync(join(tmpdir(), "e2ee-session-"));
const deviceId = "dev-1";
const pairingId = "pair-1";

try {
  const bridge = new E2eeSession({ stateDir: dir });
  assert.ok(!bridge.isPinned);

  // --- 配对（模拟 HOST：生成 secret 写 pairing.json） ---
  const pairingSecret = c.randomPairingSecret();
  writeFileSync(join(dir, "pairing.json"), JSON.stringify({ [pairingId]: { secret: pairingSecret, expiresAt: Date.now() + 120000 } }));
  const phone = c.generateIdentityKeypair();
  const kps = c.pairingAuthKey(pairingSecret);
  const ctx = c.pairingContext({
    pairingId, deviceId,
    bridgePubRaw: c.fromB64url(bridge.identity.pubKey),
    phonePubRaw: c.fromB64url(phone.pubKey),
    role: "phone",
  });
  const goodAuth = c.toB64url(c.pairingAuth(kps, ctx));

  // 错误 auth 被拒
  assert.strictEqual(
    bridge.completePairing({ pairingId, deviceId, phonePubB64url: phone.pubKey, authB64url: c.toB64url(Buffer.alloc(32)) }).ok,
    false,
  );
  // 正确 auth 成功 + pin
  const r = bridge.completePairing({ pairingId, deviceId, phonePubB64url: phone.pubKey, authB64url: goodAuth });
  assert.strictEqual(r.ok, true);
  assert.strictEqual(bridge.pinnedPeer.keyId, phone.keyId);

  // --- 连接 + 密钥派生（phone 侧镜像计算） ---
  const bridgeHello = bridge.beginConnection();
  const phoneCNonce = c.randomConnectionNonce();
  const msPhone = c.computeSharedSecret(phone.privKey, bridge.identity.pubKey);
  const ctxConn = c.connectionContext({
    keyIdPhoneHex: phone.keyId, keyIdBridgeHex: bridge.identity.keyId,
    cNoncePhoneB64url: phoneCNonce, cNonceBridgeB64url: bridgeHello.cNonce,
  });
  const phoneKeys = c.deriveConnectionKeys(msPhone, ctxConn);
  assert.strictEqual(bridge.establishConnection({ peerKeyIdHex: phone.keyId, peerCNonceB64url: phoneCNonce }), true);
  // keyId 不符应拒绝
  assert.strictEqual(bridge.establishConnection({ peerKeyIdHex: "ffffffffffffffff", peerCNonceB64url: phoneCNonce }), false);

  // --- phone -> bridge（p2b）解密 ---
  const dirP2b = c.DIR.p2b;
  const meta = { subscriptionId: "s-1", sequence: 3 };
  const aadIn = c.canonicalAAD({ type: "sessions.list", requestId: "r1", targetDeviceId: deviceId, keyIdHex: phone.keyId, version: 1, dir: dirP2b, seq: 1, meta });
  const { ct: ctIn } = c.encryptPayload({ key: phoneKeys.p2b, dir: dirP2b, seq: 1, aad: aadIn, plaintext: JSON.stringify({ hello: "phone" }) });
  const envIn = { type: "sessions.list", requestId: "r1", targetDeviceId: deviceId, crypto: { version: 1, keyId: phone.keyId, dir: dirP2b, seq: 1 }, meta, payload: { enc: "aes-256-gcm", ct: ctIn } };
  assert.deepStrictEqual(bridge.decryptIncoming(envIn), { hello: "phone" });

  // replay：同 seq 重放应抛
  assert.throws(() => bridge.decryptIncoming(envIn), /replay/);

  // --- bridge -> phone（b2p）加密，phone 侧解密 ---
  const out = bridge.encryptOutgoing({ type: "events.forward", requestId: "r2", targetDeviceId: deviceId, meta: {}, plaintextObj: { ok: true, data: { n: 1 } } });
  assert.strictEqual(out.crypto.dir, c.DIR.b2p);
  assert.strictEqual(out.crypto.seq, 1);
  const aadOut = c.canonicalAAD({ type: "events.forward", requestId: "r2", targetDeviceId: deviceId, keyIdHex: bridge.identity.keyId, version: 1, dir: out.crypto.dir, seq: out.crypto.seq, meta: {} });
  const plainOut = c.decryptPayload({ key: phoneKeys.b2p, dir: out.crypto.dir, seq: out.crypto.seq, aad: aadOut, ctB64url: out.payload.ct });
  assert.deepStrictEqual(JSON.parse(plainOut), { ok: true, data: { n: 1 } });

  console.log("✓ E2eeSession 单测通过（配对/auth 拒绝/pin/密钥派生/replay/双向加解密）");
} finally {
  rmSync(dir, { recursive: true, force: true });
}
