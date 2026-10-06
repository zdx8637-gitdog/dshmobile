// smoke-e2ee-restart.mjs：验证桥重启后的 E2EE 连接密钥失效处理——
// decryptEnvelope 在「未建立连接但收到密文」与「解密失败」时回 E2EE_RESTARTED，
// 明文放行与 E2EE_REQUIRED 原有语义不变。
import { RelayBridge } from "../bridge/relay.js";
import { supportsRequireE2ee } from "../bridge/e2ee-policy.js";

let failures = 0;
const check = (n, c, e = "") => {
  if (c) console.log("  PASS", n);
  else { failures += 1; console.log("  FAIL", n, e); }
};

function makeBridge(e2ee) {
  const b = new RelayBridge({
    url: "https://relay.example",
    username: "", password: "",
    deviceLabel: "t", platform: "windows", clientDeviceKey: "k",
    stateDir: null, accessToken: "", refreshToken: "",
    e2ee,
  });
  b.deviceId = "dev-1";
  const sent = [];
  b.ws = { readyState: 1, send: (s) => sent.push(JSON.parse(s)) };
  return { b, sent };
}

const req = (extra = {}) => ({
  schemaVersion: 1,
  envelopeId: "env-1",
  kind: "request",
  type: "sessions.history",
  requestId: "req-1",
  actor: { role: "client", clientId: "c1" },
  target: { deviceId: "dev-1" },
  payload: {},
  ...extra,
});

console.log("[1] 未建立连接 + 加密信封 → E2EE_RESTARTED，不进入 adapter");
{
  const { b, sent } = makeBridge({ isConnectionEstablished: false, decryptIncoming: null, encryptOutgoing: null });
  const r = b.decryptEnvelope(req({ crypto: { version: 1, keyId: "x", dir: 1, seq: 1 }, payload: { enc: "aes-256-gcm", ct: "AAA" } }));
  check("返回 null（不透传密文）", r === null, JSON.stringify(r));
  check("回 E2EE_RESTARTED 错误", sent.length === 1 && sent[0].payload?.error?.code === "E2EE_RESTARTED" && sent[0].requestId === "req-1", JSON.stringify(sent));
}

console.log("[2] 未建立连接 + 明文信封 → 原样放行（legacy/未配对语义不变）");
{
  const { b, sent } = makeBridge({ isConnectionEstablished: false, decryptIncoming: null, encryptOutgoing: null });
  const r = b.decryptEnvelope(req());
  check("明文原样返回", r?.kind === "request" && r.requestId === "req-1" && sent.length === 0, JSON.stringify({ r, sent }));
}

console.log("[3] 已建立连接 + 解密失败（旧密钥）→ E2EE_RESTARTED，不抛异常");
{
  const { b, sent } = makeBridge({
    isConnectionEstablished: true,
    decryptIncoming: () => { throw new Error("Unsupported state or unable to authenticate data"); },
    encryptOutgoing: null,
  });
  const r = b.decryptEnvelope(req({ crypto: { version: 1, keyId: "x", dir: 1, seq: 9 }, payload: { enc: "aes-256-gcm", ct: "BBB" } }));
  check("返回 null", r === null);
  check("回 E2EE_RESTARTED", sent.length === 1 && sent[0].payload?.error?.code === "E2EE_RESTARTED", JSON.stringify(sent));
}

console.log("[4] 已建立连接 + 明文信封 → E2EE_REQUIRED（1.0.6 版本闸门语义）");
{
  // 未上报 appVersion 的老客户端 → fail-open：不回 E2EE_REQUIRED（见 smoke-e2ee-require ①）
  const { b, sent } = makeBridge({ isConnectionEstablished: true, decryptIncoming: null, encryptOutgoing: null });
  b.decryptEnvelope(req());
  check("老客户端（无 appVersion）不回 E2EE_REQUIRED", sent.length === 0, JSON.stringify(sent));
  // 上报 appVersion=0.2.21 的客户端 → 保留强制语义：回 E2EE_REQUIRED
  //（模拟 adapter 的真实接线：版本闸门守卫；无版本 fail-open、≥0.2.21 强制）
  const { b: b2, sent: sent2 } = makeBridge({ isConnectionEstablished: true, decryptIncoming: null, encryptOutgoing: null });
  b2.setPlaintextGuard((env) => !supportsRequireE2ee(typeof env?.appVersion === "string" ? env.appVersion : undefined));
  const r2 = b2.decryptEnvelope(req({ appVersion: "0.2.21" }));
  check("0.2.21+ 明文 → 回 E2EE_REQUIRED", r2 === null && sent2.length === 1 && sent2[0].payload?.error?.code === "E2EE_REQUIRED", JSON.stringify(sent2));
}

console.log("[5] 明文类型（hello/心跳）任何状态原样放行");
{
  const { b, sent } = makeBridge({ isConnectionEstablished: false, decryptIncoming: null, encryptOutgoing: null });
  const r = b.decryptEnvelope(req({ type: "e2ee.hello", payload: { keyId: "k", cNonce: "n" } }));
  check("hello 原样返回", r?.type === "e2ee.hello" && sent.length === 0, JSON.stringify({ r, sent }));
}

console.log("[6] transfer.deliver：relay 明文投递指令任何状态放行（双向不加密，relay 可读）");
{
  const { b, sent } = makeBridge({ isConnectionEstablished: true, decryptIncoming: null, encryptOutgoing: null });
  const r = b.decryptEnvelope(req({ type: "transfer.deliver", actor: { role: "relay" }, payload: { transferId: "t1" } }));
  check("解密侧原样放行且不回错误", r?.type === "transfer.deliver" && sent.length === 0, JSON.stringify({ r, sent }));
  const out = b.encryptEnvelope({ schemaVersion: 1, envelopeId: "e2", kind: "response", type: "transfer.deliver", requestId: "req-1", actor: { role: "bridge", deviceId: "dev-1" }, payload: { ok: true, data: { path: "uploads/x.jpg" } } });
  check("加密侧不加密（响应为明文）", out.payload?.ok === true && !out.crypto, JSON.stringify(out));
}

console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILURES`);
process.exit(failures === 0 ? 0 : 1);
