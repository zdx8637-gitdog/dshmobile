// 验证：sessions.run 携带 /plan 时被正确路由到 commands/execute（而不是发给模型）
const RELAY = "https://www.deepseek-claudex.cn";
const loginRes = await fetch(`${RELAY}/auth/login`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ username: "dshtest", password: process.env.TEST_PASS ?? "" }) });
const login = await loginRes.json();
const devRes = await fetch(`${RELAY}/devices`, { headers: { authorization: `Bearer ${login.data.accessToken}` } });
const dev = await devRes.json();
const online = (dev.data || []).find((d) => d.status === "online");
const ws = new WebSocket(`${RELAY.replace(/^https/, "wss")}/ws/client?targetDeviceId=${online.id}&clientId=slashprobe-${Date.now()}`, ["bearer", login.data.accessToken]);
const pending = new Map();
function send(type, payload) {
  return new Promise((resolve) => {
    const requestId = "r-" + Math.random().toString(36).slice(2, 10);
    pending.set(requestId, resolve);
    ws.send(JSON.stringify({ schemaVersion: 1, kind: "request", envelopeId: requestId, type, sentAt: new Date().toISOString(), requestId, actor: { role: "client", clientId: "slashprobe" }, target: { deviceId: online.id }, payload }));
  });
}
ws.onmessage = (ev) => {
  const e = JSON.parse(ev.data);
  if (pending.has(e.requestId)) { pending.get(e.requestId)(e); pending.delete(e.requestId); }
};
ws.onopen = async () => {
  const sid = "session-a6a330c4-c24f-4666-99c3-a8419f56070f";
  // 经 sessions.run 发 /plan off（先确保退出 plan mode）
  const off = await send("sessions.run", { sessionId: sid, content: [{ type: "text", text: "/plan off" }] });
  console.log("sessions.run('/plan off'):", off.payload?.ok ? JSON.stringify(off.payload.data?.result ?? off.payload.data) : JSON.stringify(off.payload?.error));
  // 再经 sessions.run 发 /plan
  const on = await send("sessions.run", { sessionId: sid, content: [{ type: "text", text: "/plan" }] });
  console.log("sessions.run('/plan'):", on.payload?.ok ? JSON.stringify(on.payload.data?.result ?? on.payload.data) : JSON.stringify(on.payload?.error));
  // 普通文本仍走 prompt
  const txt = await send("sessions.run", { sessionId: sid, content: [{ type: "text", text: "reply ok" }] });
  console.log("sessions.run('reply ok'):", txt.payload?.ok ? "accepted" : JSON.stringify(txt.payload?.error));
  ws.close();
  process.exit(0);
};
setTimeout(() => { console.log("TIMEOUT"); process.exit(1); }, 40000);
