// 验证：sessions.history 经 bridge 默认上限后返回的事件量与可渲染性
const RELAY = "https://www.deepseek-claudex.cn";
const loginRes = await fetch(`${RELAY}/auth/login`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ username: "dshtest", password: process.env.TEST_PASS ?? "" }) });
const login = await loginRes.json();
const devRes = await fetch(`${RELAY}/devices`, { headers: { authorization: `Bearer ${login.data.accessToken}` } });
const dev = await devRes.json();
const online = (dev.data || []).find((d) => d.status === "online");
const ws = new WebSocket(`${RELAY.replace(/^https/, "wss")}/ws/client?targetDeviceId=${online.id}&clientId=simhist-${Date.now()}`, ["bearer", login.data.accessToken]);
const pending = new Map();
function send(type, payload) {
  return new Promise((resolve) => {
    const requestId = "r-" + Math.random().toString(36).slice(2, 10);
    pending.set(requestId, resolve);
    ws.send(JSON.stringify({ schemaVersion: 1, kind: "request", envelopeId: requestId, type, sentAt: new Date().toISOString(), requestId, actor: { role: "client", clientId: "simhist" }, target: { deviceId: online.id }, payload }));
  });
}
const listEnv = await new Promise((resolve, reject) => {
  const to = setTimeout(() => reject(new Error("list timeout")), 15000);
  ws.onmessage = (ev) => { const e = JSON.parse(ev.data); if (pending.has(e.requestId)) { clearTimeout(to); resolve(e); } };
  ws.onopen = () => send("sessions.list", {}).then(() => {});
});
const sessions = listEnv.payload?.data?.sessions || [];
const big = sessions.find((s) => s.sessionId === "60396e55-aa0c-484b-b30e-aa0e8caef938") || sessions[0];
console.log("open session:", big.sessionId.slice(0, 16), big.projections?.values?.title ?? "");

const histEnv = await new Promise((resolve, reject) => {
  const to = setTimeout(() => reject(new Error("history timeout")), 30000);
  const cb = (ev) => { const e = JSON.parse(ev.data); if (pending.has(e.requestId)) { clearTimeout(to); resolve(e); } };
  ws.onmessage = (ev) => { cb(ev); };
  send("sessions.history", { sessionId: big.sessionId });
});
const events = histEnv.payload?.data?.events || [];
const msgTypes = events.filter((e) => ["user/message", "assistant/message"].includes(e.event?.type));
console.log(`history: ok=${histEnv.payload?.ok}, total events=${events.length}, user/assistant messages=${msgTypes.length}`);
for (const m of msgTypes.slice(0, 4)) {
  const text = (m.event.data.message?.content || []).filter((c) => c.type === "text").map((c) => c.text).join(" ").slice(0, 100);
  console.log(`  ${m.event.type === "user/message" ? "👤" : "🤖"} ${text}`);
}
ws.close();
process.exit(0);
