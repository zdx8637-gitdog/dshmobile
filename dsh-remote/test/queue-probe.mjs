// 验证 session/queue 帧流：订阅会话，排队发一条消息，打印收到的 queue 帧
const RELAY = "https://www.deepseek-claudex.cn";
const SID = process.argv[2] ?? "session-79863fce-ebfb-43a9-bff3-0b7f4566798c";
const loginRes = await fetch(`${RELAY}/auth/login`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ username: "dshtest", password: process.env.TEST_PASS ?? "" }) });
const login = await loginRes.json();
const devRes = await fetch(`${RELAY}/devices`, { headers: { authorization: `Bearer ${login.data.accessToken}` } });
const dev = await devRes.json();
const online = (dev.data || []).find((d) => d.status === "online" && d.label === "DSH Bridge (windows-p)");
const ws = new WebSocket(`${RELAY.replace(/^https/, "wss")}/ws/client?targetDeviceId=${online.id}&clientId=qp-${Date.now()}`, ["bearer", login.data.accessToken]);
const pending = new Map();
function send(type, payload) {
  return new Promise((resolve) => {
    const requestId = "r-" + Math.random().toString(36).slice(2, 10);
    pending.set(requestId, resolve);
    ws.send(JSON.stringify({ schemaVersion: 1, kind: "request", envelopeId: requestId, type, sentAt: new Date().toISOString(), requestId, actor: { role: "client", clientId: "qp" }, target: { deviceId: online.id }, payload }));
  });
}
ws.onmessage = (ev) => {
  const e = JSON.parse(ev.data);
  if (pending.has(e.requestId)) { pending.get(e.requestId)(e); pending.delete(e.requestId); return; }
  if (e.kind === "event" && e.payload?.frame?.type === "session/queue") {
    console.log("QUEUE FRAME:", JSON.stringify(e.payload.frame).slice(0, 400));
  }
};
ws.onopen = async () => {
  await send("events.subscribe", { sessionId: SID });
  const resp = await send("sessions.run", { sessionId: SID, content: [{ type: "text", text: "queue probe message" }] });
  console.log("prompt:", resp.payload?.ok ? "accepted" : JSON.stringify(resp.payload?.error));
};
setTimeout(() => { ws.close(); process.exit(0); }, 20000);
