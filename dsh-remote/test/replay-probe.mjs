// 验证 bridge 暂存/重放：订�?66323133，看能否收到被重放的挂起提问
const RELAY = "https://www.deepseek-claudex.cn";
const SID = process.argv[2] ?? "session-66323133-15fd-4b6d-831d-fe9cb541c033";
const loginRes = await fetch(`${RELAY}/auth/login`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ username: "dshtest", password: process.env.TEST_PASS ?? "" }) });
const login = await loginRes.json();
const devRes = await fetch(`${RELAY}/devices`, { headers: { authorization: `Bearer ${login.data.accessToken}` } });
const dev = await devRes.json();
const online = (dev.data || []).find((d) => d.status === "online" && d.label === "DSH Bridge (windows-p)");
const ws = new WebSocket(`${RELAY.replace(/^https/, "wss")}/ws/client?targetDeviceId=${online.id}&clientId=rp-${Date.now()}`, ["bearer", login.data.accessToken]);
const pending = new Map();
function send(type, payload) {
  return new Promise((resolve, reject) => {
    const requestId = "r-" + Math.random().toString(36).slice(2, 10);
    const timer = setTimeout(() => { pending.delete(requestId); reject(new Error("timeout " + type)); }, 15000);
    pending.set(requestId, (e) => { clearTimeout(timer); resolve(e); });
    ws.send(JSON.stringify({ schemaVersion: 1, kind: "request", envelopeId: requestId, type, sentAt: new Date().toISOString(), requestId, actor: { role: "client", clientId: "rp" }, target: { deviceId: online.id }, payload }));
  });
}
ws.onmessage = (ev) => {
  const e = JSON.parse(ev.data);
  if (pending.has(e.requestId)) { pending.get(e.requestId)(e); pending.delete(e.requestId); return; }
  if (e.kind === "event" && e.payload?.frame) {
    const t = e.payload.frame.type;
    console.log("event:", t, "rpcId:", e.payload.rpcId ?? "-", JSON.stringify(e.payload.frame).slice(0, 200));
  }
};
ws.onopen = async () => {
  try {
    const sub = await send("events.subscribe", { sessionId: SID });
    console.log("subscribed:", JSON.stringify(sub.payload));
  } catch (err) { console.log("FAIL:", err.message); }
};
setTimeout(() => { ws.close(); process.exit(0); }, 12000);
