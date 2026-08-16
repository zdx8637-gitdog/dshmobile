// 验证 bridge 是否对已订阅会话转发 mux 事件
const RELAY = "https://www.deepseek-claudex.cn";
const loginRes = await fetch(`${RELAY}/auth/login`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ username: "dshtest", password: process.env.TEST_PASS ?? "" }) });
const login = await loginRes.json();
const devRes = await fetch(`${RELAY}/devices`, { headers: { authorization: `Bearer ${login.data.accessToken}` } });
const dev = await devRes.json();
const online = (dev.data || []).find((d) => d.status === "online");
const ws = new WebSocket(`${RELAY.replace(/^https/, "wss")}/ws/client?targetDeviceId=${online.id}&clientId=muxprobe-${Date.now()}`, ["bearer", login.data.accessToken]);
const pending = new Map();
function send(type, payload) {
  return new Promise((resolve) => {
    const requestId = "r-" + Math.random().toString(36).slice(2, 10);
    pending.set(requestId, resolve);
    ws.send(JSON.stringify({ schemaVersion: 1, kind: "request", envelopeId: requestId, type, sentAt: new Date().toISOString(), requestId, actor: { role: "client", clientId: "muxprobe" }, target: { deviceId: online.id }, payload }));
  });
}
let eventCount = 0;
ws.onmessage = (ev) => {
  const e = JSON.parse(ev.data);
  if (pending.has(e.requestId)) { pending.get(e.requestId)(e); pending.delete(e.requestId); return; }
  if (e.kind === "event") {
    eventCount++;
    if (eventCount <= 3) console.log("EVENT:", e.type, "frameType:", e.payload?.frame?.type, "sid:", e.payload?.sessionId?.slice(0, 13));
  }
};
ws.onopen = async () => {
  // 订阅 + 立即发消息（验证事件回传全链路）
  const sid = "session-a6a330c4-c24f-4666-99c3-a8419f56070f";
  await send("events.subscribe", { sessionId: sid });
  console.log("subscribed");
  const runResp = await send("sessions.run", { sessionId: sid, content: [{ type: "text", text: "say ping" }] });
  console.log("run:", runResp.payload?.ok ? "accepted" : JSON.stringify(runResp.payload?.error ?? runResp.payload));
};
setTimeout(() => { console.log(`total events in 30s: ${eventCount}`); ws.close(); process.exit(eventCount > 0 ? 0 : 1); }, 30000);
