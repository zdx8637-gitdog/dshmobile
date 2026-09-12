// relay-live-test.mjs：手机模拟器——真实交互复现：审批（$events 瀑布 + 应答）与提问（ask_user_question + 应答）。
// 流程：E2EE 握手 → 建临时会话 → 触发审批消息 → 应答 allowed-once → 触发提问消息 → 回答选项 A。
// 打印全部事件帧（events.forward），用于定位桥/DSH 两侧问题。
// 注意：若桥未 pin 本探针，会自动重新配对（顶掉当前 E2EE 对端，测试后手机需重扫面板②码）。
// 用法：node scripts/relay-live-test.mjs [relayUrl] [sessionId?]
import { randomUUID } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import * as c from "../bridge/crypto.js";

const relayUrl = (process.argv[2] || "https://www.deepseek-claudex.cn").replace(/\/$/, "");
const config = JSON.parse(readFileSync("C:/Users/zdx86/.dsh-mobile/config.json", "utf8"));
const accessToken = config?.relay?.accessToken ?? "";
let deviceId = "";
try { deviceId = JSON.parse(readFileSync("C:/Users/zdx86/.dsh-mobile/device-id.json", "utf8"))?.deviceId ?? ""; } catch {}
if (!accessToken || !deviceId) { console.log("FAIL: 缺少 token/deviceId"); process.exit(1); }

const panel = await (await fetch("http://127.0.0.1:17653/state")).json();
const e2ee = panel?.data ?? {};
if (!e2ee.e2eePubKey || !e2ee.e2eePairingSecret || !e2ee.e2eePairingId) { console.log("FAIL: 面板无有效 E2EE 码"); process.exit(1); }

const phone = (() => {
  const idFile = new URL("./.relay-probe-identity.json", import.meta.url);
  try {
    const saved = JSON.parse(readFileSync(idFile, "utf8"));
    if (saved?.pubKey && saved?.privKey && saved?.keyId) return saved;
  } catch {}
  const fresh = c.generateIdentityKeypair();
  try { writeFileSync(idFile, JSON.stringify(fresh, null, 2)); } catch {}
  return fresh;
})();
const phoneCNonce = c.randomConnectionNonce();
const pairingAuth = c.toB64url(c.pairingAuth(
  c.pairingAuthKey(e2ee.e2eePairingSecret),
  c.pairingContext({ pairingId: e2ee.e2eePairingId, deviceId, bridgePubRaw: c.fromB64url(e2ee.e2eePubKey), phonePubRaw: c.fromB64url(phone.pubKey), role: "phone" }),
));

const clientId = `live-${randomUUID().slice(0, 8)}`;
console.log(`[live] 连 relay，deviceId=${deviceId}`);
const ws = new WebSocket(
  `${relayUrl.replace(/^https/, "wss")}/ws/client?clientId=${clientId}&targetDeviceId=${encodeURIComponent(deviceId)}`,
  ["bearer", accessToken],
);

let keys = null;
let bridgeKeyId = "";
let seq = 0;
let stage = "status";
let sessionId = process.argv[3] || "";
let createdForTest = false;
let observed = [];

function sendPlain(type, requestId, payload) {
  ws.send(JSON.stringify({
    schemaVersion: 1, envelopeId: randomUUID(), kind: "request", type, requestId,
    sentAt: new Date().toISOString(), actor: { role: "client", clientId }, target: { deviceId }, payload,
  }));
}
function sendEncrypted(type, requestId, payloadObj) {
  seq += 1;
  const aad = c.canonicalAAD({ type, requestId, targetDeviceId: deviceId, keyIdHex: phone.keyId, version: 1, dir: c.DIR.p2b, seq, meta: {} });
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
    // 与桥一致：requestId 缺失时回退 envelopeId（事件信封没有 requestId）
    type: m.type ?? "",
    requestId: typeof m.requestId === "string" ? m.requestId : (typeof m.envelopeId === "string" ? m.envelopeId : ""),
    targetDeviceId: m.target?.deviceId ?? deviceId,
    keyIdHex: hdr.keyId ?? "", version: hdr.version ?? 1, dir: hdr.dir ?? 0, seq: hdr.seq ?? 0, meta: m.meta ?? {},
  });
  return JSON.parse(c.decryptPayload({ key: keys.b2p, dir: hdr.dir, seq: hdr.seq, aad, ctB64url: m.payload?.ct }));
}
/** 统一取明文（响应/事件都可能是加密信封）。 */
function plain(m) {
  if (m.crypto && keys) {
    try { return decrypt(m); } catch (err) { console.log("[live] 解密失败:", err.message); return m.payload ?? {}; }
  }
  return m.payload;
}

const APPROVAL_PROMPT = [{ type: "text", text: "请调用 pwsh 工具执行命令 Write-Output hello。调用时在工具参数里直接带上 sandbox_permissions: \"danger-full-access\" 和 justification: \"测试审批流\"（这会在执行前触发一次用户审批，等待放行即可）。" }];
const QUESTION_PROMPT = [{ type: "text", text: "请调用 ask_user_question 工具向我提出一个问题，给出两个选项：A（方案一）和 B（方案二）" }];
let approvalAnswered = false;
let questionAnswered = false;
let finished = false;
function finish() {
  if (finished) return;
  finished = true;
  clearTimeout(deadline);
  console.log("\n==== 汇总 ====");
  console.log("审批帧:", observed.filter((t) => t === "approval/requested").length, "应答:", approvalAnswered);
  console.log("提问帧:", observed.filter((t) => t === "question/requested").length, "应答:", questionAnswered);
  console.log("全部事件:", [...new Set(observed)].join(", "));
  setTimeout(() => { ws.close(); process.exit(0); }, 1500);
}
let deadline = setTimeout(() => {
  if (finished) return;
  console.log(`\nTIMEOUT at stage=${stage}`);
  console.log("已观察事件:", JSON.stringify([...new Set(observed)], null, 2));
  process.exit(1);
}, 240000);

ws.onopen = () => console.log("[live] WS 已连接");
ws.onmessage = (ev) => {
  let m;
  try { m = JSON.parse(ev.data); } catch { return; }
  if (m.type === "device.status") {
    console.log(`[live] 设备在线: ${m.payload?.online}`);
    if (m.payload?.online !== true) process.exit(1);
    stage = "hello";
    sendPlain("e2ee.hello", "live-hello", { keyId: phone.keyId, cNonce: phoneCNonce });
    return;
  }
  if (m.kind === "response" && m.requestId === "live-hello") {
    const p = plain(m);
    if (p?.ok !== true) {
      if (p?.error?.code === "key-mismatch") {
        console.log("[live] 未 pin 本探针 → 完整配对（会顶掉当前 E2EE 对端）");
        stage = "key-exchange";
        sendPlain("key.exchange", "live-kx", { pairingId: e2ee.e2eePairingId, deviceId, pub: phone.pubKey, auth: pairingAuth });
        return;
      }
      console.log("[live] hello 失败:", JSON.stringify(p));
      process.exit(1);
    }
    bridgeKeyId = p.data?.keyId;
    const ms = c.computeSharedSecret(phone.privKey, e2ee.e2eePubKey);
    const ctx = c.connectionContext({
      keyIdPhoneHex: phone.keyId, keyIdBridgeHex: bridgeKeyId,
      cNoncePhoneB64url: phoneCNonce, cNonceBridgeB64url: p.data?.cNonce,
    });
    keys = c.deriveConnectionKeys(ms, ctx);
    console.log("[live] E2EE 已建立");
    stage = sessionId ? "run-approval" : "create-session";
    if (sessionId) sendEncrypted("sessions.run", "live-run1", { sessionId, content: APPROVAL_PROMPT });
    else sendEncrypted("sessions.create", "live-create", {});
    return;
  }
  if (m.kind === "response" && m.requestId === "live-kx") {
    const p = plain(m);
    if (p?.ok !== true) { console.log("[live] key.exchange 失败:", JSON.stringify(p)); process.exit(1); }
    stage = "hello";
    sendPlain("e2ee.hello", "live-hello", { keyId: phone.keyId, cNonce: phoneCNonce });
    return;
  }
  if (m.kind === "response" && m.requestId === "live-create") {
    const p = plain(m);
    if (p?.ok !== true) { console.log("[live] sessions.create 失败:", JSON.stringify(p)); process.exit(1); }
    sessionId = p.data?.sessionId;
    createdForTest = true;
    console.log(`[live] 临时会话: ${sessionId}`);
    stage = "subscribe";
    sendEncrypted("events.subscribe", "live-sub", { sessionId });
    return;
  }
  if (m.kind === "response" && m.requestId === "live-sub") {
    console.log("[live] 已订阅会话事件 → 触发审批消息");
    stage = "run-approval";
    sendEncrypted("sessions.run", "live-run1", { sessionId, content: APPROVAL_PROMPT });
    return;
  }
  if (m.kind === "response" && (m.requestId === "live-run1" || m.requestId === "live-run2")) {
    console.log(`[live] ${m.type} 响应:`, JSON.stringify(plain(m)).slice(0, 200));
    return;
  }
  if (m.kind === "event") {
    // 解密 events.forward
    const p = plain(m);
    const frame = p?.frame ?? {};
    const t = frame?.type ?? m.type;
    observed.push(t);
    if (t === "approval/requested") {
      console.log("\n✅ 收到 approval/requested:", JSON.stringify({ rpcId: p.rpcId, frame }, null, 2).slice(0, 800));
      if (!approvalAnswered) {
        approvalAnswered = true;
        stage = "answer-approval";
        console.log("[live] 应答 allowed-once…");
        sendEncrypted("approvals.respond", "live-answer1", { rpcId: p.rpcId, outcome: "allowed-once", sessionId });
      }
    } else if (t === "question/requested") {
      console.log("\n✅ 收到 question/requested:", JSON.stringify({ rpcId: p.rpcId, frame }, null, 2).slice(0, 1200));
      if (!questionAnswered) {
        questionAnswered = true;
        stage = "answer-question";
        const q = frame.questions?.[0] ?? {};
        const label = q.options?.[0]?.label ?? "A";
        console.log(`[live] 回答选项 ${label}…`);
        sendEncrypted("questions.respond", "live-answer2", { rpcId: p.rpcId, answer: { answers: [{ id: q.id, selected: [label] }] }, sessionId });
      }
    } else if (t === "approval/resolved" || t === "question/resolved") {
      console.log(`[live] ${t}（他端已应答/已解析）`);
    } else if (t === "session/event") {
      const et = frame.event?.type;
      if (["assistant/message", "turn/end", "turn/start", "tool/result", "user/message"].includes(et)) {
        console.log(`[live] session/event: ${et}`);
        if (et === "turn/end" && approvalAnswered && questionAnswered) finish();
      }
    } else if (t === "session/queue") {
      console.log(`[live] session/queue items=${frame.items?.length ?? 0}`);
    } else {
      console.log(`[live] 事件: ${t}`);
    }
    return;
  }
  if (m.kind === "response" && m.requestId === "live-answer1") {
    console.log("[live] approvals.respond 响应:", JSON.stringify(plain(m)).slice(0, 200));
    if (plain(m)?.ok === true && questionAnswered) {
      // 提问之后触发的审批：等 turn/end 汇总（见事件分支）
      console.log("[live] 审批已应答 → 等待回合收尾");
    } else if (plain(m)?.ok === true && !questionAnswered) {
      console.log("[live] 审批轮完成 → 触发提问");
      stage = "run-question";
      setTimeout(() => sendEncrypted("sessions.run", "live-run2", { sessionId, content: QUESTION_PROMPT }), 2000);
    }
    return;
  }
  if (m.kind === "response" && m.requestId === "live-answer2") {
    console.log("[live] questions.respond 响应:", JSON.stringify(plain(m)).slice(0, 200));
    // 回答后 agent 可能按选项去提权重试 → 继续等审批（turn/end 时汇总）
    stage = "wait-approval";
    console.log("[live] 提问已回答 → 继续监听审批（agent 可能按选项重试提权）…");
    return;
  }
  if (m.kind === "error") {
    console.log("[live] relay 错误:", m.type, m.payload?.error?.message ?? JSON.stringify(m.payload ?? m));
  }
};
ws.onerror = () => console.log("[live] WS error");
ws.onclose = () => process.exit(0);
