// 触发一次审批，并打印 approval/requested 帧（含 rpcId），15s 后自动允许
const RELAY = "https://www.deepseek-claudex.cn";
const SID = process.argv[2] ?? "session-79863fce-ebfb-43a9-bff3-0b7f4566798c";
const loginRes = await fetch(`${RELAY}/auth/login`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ username: "dshtest", password: process.env.TEST_PASS ?? "" }) });
const login = await loginRes.json();
const devRes = await fetch(`${RELAY}/devices`, { headers: { authorization: `Bearer ${login.data.accessToken}` } });
const dev = await devRes.json();
const online = (dev.data || []).find((d) => d.status === "online" && d.label === "DSH Bridge (windows-p)");
const ws = new WebSocket(`${RELAY.replace(/^https/, "wss")}/ws/client?targetDeviceId=${online.id}&clientId=ap2-${Date.now()}`, ["bearer", login.data.accessToken]);
const pending = new Map();
function send(type, payload) {
  return new Promise((resolve) => {
    const requestId = "r-" + Math.random().toString(36).slice(2, 10);
    pending.set(requestId, resolve);
    ws.send(JSON.stringify({ schemaVersion: 1, kind: "request", envelopeId: requestId, type, sentAt: new Date().toISOString(), requestId, actor: { role: "client", clientId: "ap2" }, target: { deviceId: online.id }, payload }));
  });
}
let approvalRpcId = null;
let approvalId = null;
ws.onmessage = (ev) => {
  const e = JSON.parse(ev.data);
  if (pending.has(e.requestId)) { pending.get(e.requestId)(e); pending.delete(e.requestId); return; }
  if (e.kind === "event" && e.payload?.frame?.type === "approval/requested") {
    approvalRpcId = e.payload.rpcId ?? null;
    approvalId = e.payload.frame.approvalId ?? null;
    console.log("APPROVAL FRAME: envelope.rpcId=", approvalRpcId, " frame.approvalId=", approvalId, " toolName=", e.payload.frame.toolName);
    console.log("FULL envelope.payload keys:", Object.keys(e.payload ?? {}));
  }
  if (e.kind === "event" && e.payload?.frame?.type === "approval/resolved") {
    console.log("APPROVAL RESOLVED:", JSON.stringify(e.payload.frame).slice(0, 120));
  }
};
ws.onopen = async () => {
  await send("events.subscribe", { sessionId: SID });
  const resp = await send("sessions.run", { sessionId: SID, content: [{ type: "text", text: "请用 pwsh 工具运行命令 Start-Sleep -Seconds 10" }] });
  console.log("prompt:", resp.payload?.ok ? "accepted" : JSON.stringify(resp.payload?.error));
};
// 30s 后若还没人应答，用探针自己允许（测试清理）
setTimeout(async () => {
  if (approvalRpcId && approvalId) {
    const resp = await send("approvals.respond", { sessionId: SID, approvalId, outcome: "allowed-once", rpcId: approvalRpcId });
    console.log("probe auto-allow:", JSON.stringify(resp.payload));
  } else {
    console.log("no approval seen in 30s (rpcId=", approvalRpcId, ")");
  }
  ws.close();
  process.exit(0);
}, 30000);
