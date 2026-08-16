// 对挂起提问直接应答（测试 DSH 接受/拒绝语义）
// 用法: node answer-probe.mjs <rpcId> <sessionId> [customText]
const RELAY = "https://www.deepseek-claudex.cn";
const RPCID = process.argv[2];
const SID = process.argv[3];
const CUSTOM = process.argv[4];
if (!RPCID || !SID) { console.log("usage: answer-probe.mjs <rpcId> <sessionId> [customText]"); process.exit(2); }
const loginRes = await fetch(`${RELAY}/auth/login`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ username: "dshtest", password: process.env.TEST_PASS ?? "" }) });
const login = await loginRes.json();
const devRes = await fetch(`${RELAY}/devices`, { headers: { authorization: `Bearer ${login.data.accessToken}` } });
const dev = await devRes.json();
const online = (dev.data || []).find((d) => d.status === "online" && d.label === "DSH Bridge (windows-p)");
const ws = new WebSocket(`${RELAY.replace(/^https/, "wss")}/ws/client?targetDeviceId=${online.id}&clientId=ap-${Date.now()}`, ["bearer", login.data.accessToken]);
const pending = new Map();
function send(type, payload) {
  return new Promise((resolve) => {
    const requestId = "r-" + Math.random().toString(36).slice(2, 10);
    pending.set(requestId, resolve);
    ws.send(JSON.stringify({ schemaVersion: 1, kind: "request", envelopeId: requestId, type, sentAt: new Date().toISOString(), requestId, actor: { role: "client", clientId: "ap" }, target: { deviceId: online.id }, payload }));
  });
}
ws.onmessage = (ev) => {
  const e = JSON.parse(ev.data);
  if (pending.has(e.requestId)) { pending.get(e.requestId)(e); pending.delete(e.requestId); return; }
  if (e.kind === "event" && e.payload?.frame?.type === "question/resolved") console.log("RESOLVED:", JSON.stringify(e.payload.frame).slice(0, 150));
};
ws.onopen = async () => {
  const answer = CUSTOM
    ? { answers: [{ id: "drink_choice", selected: [], custom: CUSTOM }] }
    : { answers: [{ id: "drink_choice", selected: ["咖啡"] }] };
  const resp = await send("questions.respond", { sessionId: SID, answer, rpcId: RPCID });
  console.log("respond result:", JSON.stringify(resp.payload));
  ws.close();
  setTimeout(() => process.exit(0), 500);
};
setTimeout(() => { ws.close(); process.exit(2); }, 15000);
