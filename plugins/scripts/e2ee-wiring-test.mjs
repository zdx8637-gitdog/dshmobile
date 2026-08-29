// E2EE wiring 测试：RelayBridge encrypt/decrypt 信封级透传 + AAD 上下文回退一致性。
import assert from "node:assert";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { E2eeSession } from "../bridge/e2ee.js";
import { RelayBridge } from "../bridge/relay.js";
import * as c from "../bridge/crypto.js";

const dir = mkdtempSync(join(tmpdir(), "e2ee-wiring-"));

// 与 relay.js envelopeAadContext 完全一致的镜像（两端必须同规则）
function aadCtx(env) {
  return {
    type: env.type,
    requestId: env.requestId ?? env.envelopeId ?? "",
    targetDeviceId: env.target?.deviceId ?? env.actor?.deviceId ?? "",
  };
}

try {
  const deviceId = "dev-1";
  const pairingId = "pair-1";

  // 配对（bridge=E2eeSession，phone=crypto 原语模拟；secret 由"宿主"写文件）
  const bridge = new E2eeSession({ stateDir: dir });
  const pairingSecret = c.randomPairingSecret();
  writeFileSync(join(dir, "pairing.json"), JSON.stringify({ [pairingId]: { secret: pairingSecret, expiresAt: Date.now() + 120000 } }));
  const phone = c.generateIdentityKeypair();
  const kps = c.pairingAuthKey(pairingSecret);
  const ctxP = c.pairingContext({ pairingId, deviceId, bridgePubRaw: c.fromB64url(bridge.identity.pubKey), phonePubRaw: c.fromB64url(phone.pubKey), role: "phone" });
  const auth = c.toB64url(c.pairingAuth(kps, ctxP));
  assert.strictEqual(bridge.completePairing({ pairingId, deviceId, phonePubB64url: phone.pubKey, authB64url: auth }).ok, true);

  // 连接 + phone 侧镜像派生密钥
  const bridgeHello = bridge.beginConnection();
  const phoneCNonce = c.randomConnectionNonce();
  const msPhone = c.computeSharedSecret(phone.privKey, bridge.identity.pubKey);
  const ctxC = c.connectionContext({ keyIdPhoneHex: phone.keyId, keyIdBridgeHex: bridge.identity.keyId, cNoncePhoneB64url: phoneCNonce, cNonceBridgeB64url: bridgeHello.cNonce });
  const phoneKeys = c.deriveConnectionKeys(msPhone, ctxC);
  assert.strictEqual(bridge.establishConnection({ peerKeyIdHex: phone.keyId, peerCNonceB64url: phoneCNonce }), true);

  const relay = new RelayBridge({ url: "wss://unused", e2ee: bridge });

  // 场景 1：bridge 出站 response（无 target，AAD 回退 actor.deviceId）
  const resp = { schemaVersion: 1, kind: "response", type: "sessions.list", requestId: "req-1", sentAt: new Date().toISOString(), actor: { role: "bridge", deviceId }, payload: { ok: true, data: { sessions: [] } } };
  const encResp = relay.encryptEnvelope(resp);
  assert.ok(encResp.crypto && encResp.payload.ct, "response should be encrypted");
  const cr = aadCtx(encResp);
  assert.strictEqual(cr.targetDeviceId, deviceId, "response AAD 应回退 actor.deviceId");
  const aadResp = c.canonicalAAD({ type: cr.type, requestId: cr.requestId, targetDeviceId: cr.targetDeviceId, keyIdHex: encResp.crypto.keyId, version: 1, dir: encResp.crypto.dir, seq: encResp.crypto.seq, meta: {} });
  const plainResp = c.decryptPayload({ key: phoneKeys.b2p, dir: encResp.crypto.dir, seq: encResp.crypto.seq, aad: aadResp, ctB64url: encResp.payload.ct });
  assert.deepStrictEqual(JSON.parse(plainResp), resp.payload);

  // 场景 2：phone 入站 request（有 target.deviceId）→ bridge 解密
  const seq = 1;
  const aadReq = c.canonicalAAD({ type: "sessions.list", requestId: "req-2", targetDeviceId: deviceId, keyIdHex: phone.keyId, version: 1, dir: c.DIR.p2b, seq, meta: {} });
  const { ct: ctReq } = c.encryptPayload({ key: phoneKeys.p2b, dir: c.DIR.p2b, seq, aad: aadReq, plaintext: JSON.stringify({ hello: "phone" }) });
  const reqEnv = { schemaVersion: 1, kind: "request", type: "sessions.list", requestId: "req-2", sentAt: new Date().toISOString(), actor: { role: "client", clientId: "c1" }, target: { deviceId }, crypto: { version: 1, keyId: phone.keyId, dir: c.DIR.p2b, seq }, payload: { enc: "aes-256-gcm", ct: ctReq } };
  const dec = relay.decryptEnvelope(reqEnv);
  assert.deepStrictEqual(dec.payload, { hello: "phone" });

  // 场景 3：明文类型（heartbeat）不加密
  const hb = { schemaVersion: 1, kind: "heartbeat", type: "heartbeat.ping", payload: { now: new Date().toISOString() } };
  assert.deepStrictEqual(relay.encryptEnvelope(hb), hb);

  // 场景 4：未建立连接时原样透传（legacy 兼容）
  const fresh = new RelayBridge({ url: "wss://unused" }); // 无 e2ee
  assert.deepStrictEqual(fresh.encryptEnvelope({ type: "x", payload: { a: 1 } }), { type: "x", payload: { a: 1 } });

  console.log("✓ E2EE wiring 测试通过（response 回退 / request / 明文类型 / legacy 透传）");
} finally {
  rmSync(dir, { recursive: true, force: true });
}
