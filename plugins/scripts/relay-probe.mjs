// relay-probe.mjs：手机模拟器——完整 E2EE 配对（读面板②加密码）+ 加密下发 sessions.list 并打印响应。
// 用于从 relay 链路端到端验证桥的 DSH 调用结果（无需真手机）。
// 注意：配对会把本探针身份 pin 为设备 E2EE 对端（原手机配对被顶掉，手机重扫面板②码即可恢复）。
// 用法：node scripts/relay-probe.mjs [relayUrl]
import { randomUUID } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import * as c from "../bridge/crypto.js";

const relayUrl = (process.argv[2] || "https://www.deepseek-claudex.cn").replace(/\/$/, "");
const config = JSON.parse(readFileSync("C:/Users/zdx86/.dsh-mobile/config.json", "utf8"));
const accessToken = config?.relay?.accessToken ?? "";
let deviceId = "";
try { deviceId = JSON.parse(readFileSync("C:/Users/zdx86/.dsh-mobile/device-id.json", "utf8"))?.deviceId ?? ""; } catch { /* 未注册 */ }
if (!accessToken) { console.log("FAIL: config.json 无 accessToken"); process.exit(1); }
if (!deviceId) { console.log("FAIL: 未找到 deviceId（桥可能尚未 provision）"); process.exit(1); }

// 面板 E2EE 出码（常驻有效码：pubKey/pairingSecret/pairingId/deviceId）
const panel = await (await fetch("http://127.0.0.1:17653/state")).json();
const e2ee = panel?.data ?? {};
if (!e2ee.e2eePubKey || !e2ee.e2eePairingSecret || !e2ee.e2eePairingId) {
  console.log("FAIL: 面板无有效 E2EE 码（桥未运行？）", JSON.stringify(panel).slice(0, 200));
  process.exit(1);
}

const phone = (() => {
  // 复用探针身份（状态目录，避免污染包目录）：重复运行不换身份，
  // 若桥仍 pin 本探针则直接 e2ee.hello；否则走完整配对。
  const idFile = "C:/Users/zdx86/.dsh-mobile/probe-identity.json";
  try {
    const saved = JSON.parse(readFileSync(idFile, "utf8"));
    if (saved?.pubKey && saved?.privKey && saved?.keyId) return saved;
  } catch { /* 首次运行 */ }
  const fresh = c.generateIdentityKeypair();
  try { writeFileSync(idFile, JSON.stringify(fresh, null, 2)); } catch { /* 忽略 */ }
  return fresh;
})();
const phoneCNonce = c.randomConnectionNonce();
const pairingAuth = c.toB64url(c.pairingAuth(
  c.pairingAuthKey(e2ee.e2eePairingSecret),
  c.pairingContext({
    pairingId: e2ee.e2eePairingId,
    deviceId,
    bridgePubRaw: c.fromB64url(e2ee.e2eePubKey),
    phonePubRaw: c.fromB64url(phone.pubKey),
    role: "phone",
  }),
));

const clientId = `probe-${randomUUID().slice(0, 8)}`;
console.log(`连 relay ${relayUrl}，deviceId=${deviceId}，phoneKeyId=${phone.keyId}`);
const ws = new WebSocket(
  `${relayUrl.replace(/^https/, "wss")}/ws/client?clientId=${clientId}&targetDeviceId=${encodeURIComponent(deviceId)}`,
  ["bearer", accessToken],
);

let keys = null;
let bridgeKeyId = "";
let seq = 0;
let stage = "status";
let deadline = setTimeout(() => {
  console.log(`TIMEOUT at stage=${stage}（桥未在 30s 内完成握手/应答）`);
  process.exit(1);
}, 30000);

function sendPlain(type, requestId, payload) {
  ws.send(JSON.stringify({
    schemaVersion: 1, envelopeId: randomUUID(), kind: "request", type, requestId,
    sentAt: new Date().toISOString(), actor: { role: "client", clientId }, target: { deviceId }, payload,
  }));
}

function sendEncrypted(type, requestId, payloadObj) {
  seq += 1;
  const aad = c.canonicalAAD({
    type, requestId, targetDeviceId: deviceId, keyIdHex: phone.keyId, version: 1, dir: c.DIR.p2b, seq, meta: {},
  });
  const { ct } = c.encryptPayload({ key: keys.p2b, dir: c.DIR.p2b, seq, aad, plaintext: JSON.stringify(payloadObj) });
  ws.send(JSON.stringify({
    schemaVersion: 1, envelopeId: randomUUID(), kind: "request", type, requestId,
    sentAt: new Date().toISOString(), actor: { role: "client", clientId }, target: { deviceId },
    crypto: { version: 1, keyId: phone.keyId, dir: c.DIR.p2b, seq }, payload: { enc: "aes-256-gcm", ct },
  }));
}

function decrypt(m) {
  const hdr = m.crypto ?? {};
  const aad = c.canonicalAAD({
    type: m.type ?? "", requestId: m.requestId ?? "", targetDeviceId: m.target?.deviceId ?? deviceId,
    keyIdHex: hdr.keyId ?? "", version: hdr.version ?? 1, dir: hdr.dir ?? 0, seq: hdr.seq ?? 0, meta: m.meta ?? {},
  });
  const plain = c.decryptPayload({ key: keys.b2p, dir: hdr.dir, seq: hdr.seq, aad, ctB64url: m.payload?.ct });
  return JSON.parse(plain);
}

ws.onopen = () => console.log("WS 已连接，等待 device.status…");
ws.onmessage = (ev) => {
  let m;
  try { m = JSON.parse(ev.data); } catch { return; }
  if (m.type === "device.status") {
    console.log(`设备在线: ${m.payload?.online}`);
    if (m.payload?.online !== true) { console.log("桥不在线——先重启 DSH 让桥连接 relay"); process.exit(1); }
    // 先尝试直接 e2ee.hello（若桥仍 pin 本探针身份）；key-mismatch 时回退完整配对
    stage = "hello";
    sendPlain("e2ee.hello", "probe-hello", { keyId: phone.keyId, cNonce: phoneCNonce });
    console.log("已发起 e2ee.hello（若未 pin 本探针将收到 key-mismatch，自动转配对）…");
    return;
  }
  if (m.kind === "response" && m.requestId === "probe-kx") {
    if (m.payload?.ok !== true) { console.log("key.exchange 失败:", JSON.stringify(m.payload)); process.exit(1); }
    console.log(`配对成功 peerKeyId=${m.payload.data?.peerKeyId}（探针身份已 pin 为设备 E2EE 对端）`);
    stage = "hello";
    sendPlain("e2ee.hello", "probe-hello", { keyId: phone.keyId, cNonce: phoneCNonce });
    return;
  }
  if (m.kind === "response" && m.requestId === "probe-hello") {
    if (m.payload?.ok !== true) {
      if (m.payload?.error?.code === "key-mismatch") {
        console.log("未 pin 本探针 → 完整配对（会顶掉当前 E2EE 对端）");
        stage = "key-exchange";
        sendPlain("key.exchange", "probe-kx", {
          pairingId: e2ee.e2eePairingId, deviceId, pub: phone.pubKey, auth: pairingAuth,
        });
        return;
      }
      console.log("e2ee.hello 失败:", JSON.stringify(m.payload));
      process.exit(1);
      return;
    }
    bridgeKeyId = m.payload.data?.keyId;
    const bridgeCNonce = m.payload.data?.cNonce;
    const ms = c.computeSharedSecret(phone.privKey, e2ee.e2eePubKey);
    const ctx = c.connectionContext({
      keyIdPhoneHex: phone.keyId, keyIdBridgeHex: bridgeKeyId,
      cNoncePhoneB64url: phoneCNonce, cNonceBridgeB64url: bridgeCNonce,
    });
    keys = c.deriveConnectionKeys(ms, ctx);
    console.log(`E2EE 连接建立（bridgeKeyId=${bridgeKeyId}），加密下发 sessions.list…`);
    stage = "sessions-list";
    sendEncrypted("sessions.list", "probe-sessions-list", {});
    return;
  }
  if (m.kind === "response" && m.requestId === "probe-sessions-list") {
    let p = m.payload;
    if (m.crypto && keys) {
      try { p = decrypt(m); } catch (err) { console.log("响应解密失败:", err.message); process.exit(1); }
    }
    if (p?.ok === true) {
      const sessions = p.data?.sessions ?? [];
      console.log(`\n✅ sessions.list 成功：${sessions.length} 个会话`);
      for (const s of sessions.slice(0, 5)) {
        console.log(`  - ${s.sessionId}${s.title ? `「${s.title}」` : ""}${s.cwd ? ` (${s.cwd})` : ""}`);
      }
      console.log(`  归档=${(p.data?.archivedSessionIds ?? []).length} 完成未查看=${(p.data?.completedSessionIds ?? []).length} 待应答=${(p.data?.pendingSessionIds ?? []).length}`);
      // 可选：给定 sessionId 时继续拉该会话历史（只读，验证 history 形状）
      const histSessionId = process.argv[3] || "";
      if (histSessionId) {
        stage = "sessions-history";
        sendEncrypted("sessions.history", "probe-sessions-history", { sessionId: histSessionId, maxMessages: 10 });
        return;
      }
    } else {
      console.log(`\n❌ sessions.list 失败: [${p?.error?.code}] ${p?.error?.message}`);
      console.log("（若为 HTTP 401/protocol-error：桥没有 launch token，重启 DSH 后应消失）");
    }
    clearTimeout(deadline);
    ws.close();
    return;
  }
  if (m.kind === "response" && m.requestId === "probe-sessions-history") {
    clearTimeout(deadline);
    let p = m.payload;
    if (m.crypto && keys) {
      try { p = decrypt(m); } catch (err) { console.log("响应解密失败:", err.message); process.exit(1); }
    }
    if (p?.ok === true) {
      const events = p.data?.events ?? [];
      console.log(`\n✅ sessions.history 成功：${events.length} 条事件 hasMore=${p.data?.hasMore}`);
      for (const e of events.slice(0, 8)) {
        console.log(`  - seq=${e.seq} ${e.event?.type}${e.event?.data ? ` data.keys=${Object.keys(e.event.data).join(",")}` : ""}`);
      }
      if (p.data?.projections) console.log(`  projections.keys=${Object.keys(p.data.projections.values ?? {}).join(",")}`);
    } else {
      console.log(`\n❌ sessions.history 失败: [${p?.error?.code}] ${p?.error?.message}`);
    }
    ws.close();
    return;
  }
  if (m.kind === "error") {
    console.log(`relay 错误: ${m.type}`, m.payload?.error?.message ?? JSON.stringify(m.payload ?? m));
  }
};
ws.onerror = () => console.log("WS error");
ws.onclose = () => process.exit(0);
