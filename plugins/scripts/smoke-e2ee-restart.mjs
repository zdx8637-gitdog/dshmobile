// smoke-e2ee-restart.mjs：验证桥重启后的 E2EE 连接密钥失效处理——
// decryptEnvelope 在「未建立连接但收到密文」与「解密失败」时回 E2EE_RESTARTED，
// 明文放行与 E2EE_REQUIRED 原有语义不变。
import { RelayBridge } from "../bridge/relay.js";

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

console.log("[4] 已建立连接 + 明文信封 → E2EE_REQUIRED（原有语义不变）");
{
  const { b, sent } = makeBridge({ isConnectionEstablished: true, decryptIncoming: null, encryptOutgoing: null });
  const r = b.decryptEnvelope(req());
  check("返回 null", r === null);
  check("回 E2EE_REQUIRED", sent.length === 1 && sent[0].payload?.error?.code === "E2EE_REQUIRED", JSON.stringify(sent));
}

console.log("[5] 明文类型（hello/心跳）任何状态原样放行");
{
  const { b, sent } = makeBridge({ isConnectionEstablished: false, decryptIncoming: null, encryptOutgoing: null });
  const r = b.decryptEnvelope(req({ type: "e2ee.hello", payload: { keyId: "k", cNonce: "n" } }));
  check("hello 原样返回", r?.type === "e2ee.hello" && sent.length === 0, JSON.stringify({ r, sent }));
}

console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILURES`);
process.exit(failures === 0 ? 0 : 1);
