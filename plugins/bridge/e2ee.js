// bridge 侧 E2EE 状态机：身份密钥、pinning、QR 配对、每连接密钥、payload 加解密、replay。
// 与 docs/plan-e2ee.md 及 bridge/crypto.js 字节格式一一对应。
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import * as c from "./crypto.js";

const PAIRING_TTL_MS = 120_000;

export class E2eeSession {
  /** @param {{ stateDir: string }} */
  constructor({ stateDir }) {
    this.stateDir = stateDir;
    this.keyFile = join(stateDir, "device-key.json");
    const d = this.#load();
    this.identity = d.identity; // { pubKey, privKey, keyId }
    this.pinnedPeer = d.pinnedPeer; // null | { pubKey, keyId }
    this.state = this.pinnedPeer ? "pinned" : "legacy";
    this.pairingFile = join(stateDir, "pairing.json");
    this.conn = null; // { cNonce(b64url), keys:{p2b,b2p}, sendSeq:{p2b,b2p}, recvSeq:{p2b,b2p} }
  }

  #load() {
    try {
      if (existsSync(this.keyFile)) {
        const d = JSON.parse(readFileSync(this.keyFile, "utf8"));
        if (d.pubKey && d.privKey && d.keyId) {
          return { identity: { pubKey: d.pubKey, privKey: d.privKey, keyId: d.keyId }, pinnedPeer: d.pinnedPeer ?? null };
        }
      }
    } catch {}
    const identity = c.generateIdentityKeypair();
    this.#save({ identity, pinnedPeer: null });
    return { identity, pinnedPeer: null };
  }

  #save({ identity, pinnedPeer }) {
    try {
      mkdirSync(this.stateDir, { recursive: true });
      writeFileSync(this.keyFile, JSON.stringify({ pubKey: identity.pubKey, privKey: identity.privKey, keyId: identity.keyId, pinnedPeer }, null, 2), { mode: 0o600 });
    } catch {}
  }

  // ---- 状态 ----
  get isPinned() {
    return this.pinnedPeer !== null;
  }

  get isConnectionEstablished() {
    return this.conn?.keys != null;
  }

  /** 从 pairing.json 按 pairingId 查一次性配对 secret（HOST 出码时写入，短 TTL）。 */
  #lookupPairingSecret(pairingId) {
    try {
      const f = JSON.parse(readFileSync(this.pairingFile, "utf8"));
      const entry = f?.[pairingId];
      if (!entry || typeof entry.secret !== "string") return null;
      if (Date.now() > Number(entry.expiresAt ?? 0)) return null;
      return entry.secret;
    } catch {
      return null;
    }
  }

  /** bridge 完成配对：按 pairingId 查 secret，校验 phone auth，pin phone 公钥。 */
  completePairing({ pairingId, deviceId, phonePubB64url, authB64url }) {
    const pairingSecret = this.#lookupPairingSecret(pairingId);
    if (!pairingSecret) {
      return { ok: false, error: { code: "pairing-expired", message: "pairing secret expired or unknown" } };
    }
    const kps = c.pairingAuthKey(pairingSecret);
    const phonePubRaw = c.fromB64url(phonePubB64url);
    const ctx = c.pairingContext({
      pairingId,
      deviceId,
      bridgePubRaw: c.fromB64url(this.identity.pubKey),
      phonePubRaw,
      role: "phone",
    });
    const expect = c.pairingAuth(kps, ctx);
    const got = c.fromB64url(authB64url);
    if (got.length !== expect.length || !expect.every((b, i) => b === got[i])) {
      return { ok: false, error: { code: "auth-failed", message: "pairing auth mismatch" } };
    }
    this.pinnedPeer = { pubKey: phonePubB64url, keyId: c.keyIdOf(phonePubRaw) };
    this.state = "pinned";
    this.#save({ identity: this.identity, pinnedPeer: this.pinnedPeer });
    return { ok: true, data: { peerKeyId: this.pinnedPeer.keyId } };
  }

  /** 开始一次连接：生成本端 cNonce。 */
  beginConnection() {
    this.conn = { cNonce: c.randomConnectionNonce(), keys: null, sendSeq: { [c.DIR.p2b]: 0, [c.DIR.b2p]: 0 }, recvSeq: { [c.DIR.p2b]: 0, [c.DIR.b2p]: 0 } };
    return { keyId: this.identity.keyId, cNonce: this.conn.cNonce };
  }

  /** 收到对端 hello 后派生本连接密钥。失败（keyId 不符）返回 false。 */
  establishConnection({ peerKeyIdHex, peerCNonceB64url }) {
    if (!this.pinnedPeer || !this.conn) return false;
    if (peerKeyIdHex !== this.pinnedPeer.keyId) return false;
    const ms = c.computeSharedSecret(this.identity.privKey, this.pinnedPeer.pubKey);
    const ctx = c.connectionContext({
      // phone 在前、bridge 在后（固定角色序）
      keyIdPhoneHex: this.pinnedPeer.keyId,
      keyIdBridgeHex: this.identity.keyId,
      cNoncePhoneB64url: peerCNonceB64url,
      cNonceBridgeB64url: this.conn.cNonce,
    });
    this.conn.keys = c.deriveConnectionKeys(ms, ctx);
    return true;
  }

  /** 加密一条本端发出的消息（bridge 方向 = b2p）。返回 { crypto, payload }（meta 由调用方填）。 */
  encryptOutgoing({ type, requestId, targetDeviceId, meta = {}, plaintextObj }) {
    if (!this.conn?.keys) throw new Error("E2EE connection not established");
    const dir = c.DIR.b2p;
    const seq = this.conn.sendSeq[dir] + 1;
    this.conn.sendSeq[dir] = seq;
    const key = this.conn.keys.b2p;
    const aad = c.canonicalAAD({ type, requestId, targetDeviceId, keyIdHex: this.identity.keyId, version: 1, dir, seq, meta });
    const { ct } = c.encryptPayload({ key, dir, seq, aad, plaintext: JSON.stringify(plaintextObj) });
    return { crypto: { version: 1, keyId: this.identity.keyId, dir, seq }, payload: { enc: "aes-256-gcm", ct } };
  }

  /** 解密一条对端发来的消息（bridge 接收方向 = p2b）。返回明文对象。 */
  decryptIncoming({ type, requestId, targetDeviceId, crypto: hdr, meta = {}, payload }) {
    if (!this.conn?.keys) throw new Error("E2EE connection not established");
    if (hdr?.dir !== c.DIR.p2b) throw new Error("bad direction");
    if (hdr?.keyId !== this.pinnedPeer?.keyId) throw new Error("peer keyId mismatch");
    const seq = hdr?.seq;
    if (!Number.isSafeInteger(seq) || seq <= this.conn.recvSeq[c.DIR.p2b]) throw new Error("replay: stale seq");
    const key = this.conn.keys.p2b;
    const aad = c.canonicalAAD({ type, requestId, targetDeviceId, keyIdHex: hdr.keyId, version: hdr.version ?? 1, dir: hdr.dir, seq, meta });
    const plain = c.decryptPayload({ key, dir: hdr.dir, seq, aad, ctB64url: payload?.ct });
    this.conn.recvSeq[c.DIR.p2b] = seq;
    return JSON.parse(plain);
  }

  /** 清除 pin（解除绑定/设备吊销）。 */
  clearPin() {
    this.pinnedPeer = null;
    this.state = "legacy";
    this.conn = null;
    this.#save({ identity: this.identity, pinnedPeer: null });
  }
}
