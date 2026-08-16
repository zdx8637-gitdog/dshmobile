// 通用：对指定会话发一�?prompt（用于停止按钮测试等�?// 用法: node run-probe.mjs <sessionId> <text...>
const RELAY = "https://www.deepseek-claudex.cn";
const SID = process.argv[2];
const TEXT = process.argv.slice(3).join(" ") || "回复：好";
if (!SID) { console.log("usage: run-probe.mjs <sessionId> <text>"); process.exit(2); }
const loginRes = await fetch(`${RELAY}/auth/login`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ username: "dshtest", password: process.env.TEST_PASS ?? "" }) });
const login = await loginRes.json();
const devRes = await fetch(`${RELAY}/devices`, { headers: { authorization: `Bearer ${login.data.accessToken}` } });
const dev = await devRes.json();
const online = (dev.data || []).find((d) => d.status === "online" && d.label === "DSH Bridge (windows-p)");
const ws = new WebSocket(`${RELAY.replace(/^https/, "wss")}/ws/client?targetDeviceId=${online.id}&clientId=run-${Date.now()}`, ["bearer", login.data.accessToken]);
const pending = new Map();
function send(type, payload) {
  return new Promise((resolve, reject) => {
    const requestId = "r-" + Math.random().toString(36).slice(2, 10);
    const timer = setTimeout(() => { pending.delete(requestId); reject(new Error("timeout " + type)); }, 20000);
    pending.set(requestId, (e) => { clearTimeout(timer); resolve(e); });
    ws.send(JSON.stringify({ schemaVersion: 1, kind: "request", envelopeId: requestId, type, sentAt: new Date().toISOString(), requestId, actor: { role: "client", clientId: "run" }, target: { deviceId: online.id }, payload }));
  });
}
let turnEnded = false;
ws.onmessage = (ev) => {
  const e = JSON.parse(ev.data);
  if (pending.has(e.requestId)) { pending.get(e.requestId)(e); pending.delete(e.requestId); return; }
  if (e.kind === "event" && e.payload?.frame?.type === "session/event") {
    const t = e.payload.frame.event?.type;
    if (t === "turn/start") console.log("TURN START");
    if (t === "turn/end") { console.log("TURN END"); turnEnded = true; }
  }
};
ws.onopen = async () => {
  try {
    await send("events.subscribe", { sessionId: SID });
    const resp = await send("sessions.run", { sessionId: SID, content: [{ type: "text", text: TEXT }] });
    console.log("prompt:", resp.payload?.ok ? "accepted" : JSON.stringify(resp.payload?.error));
  } catch (err) { console.log("FAIL:", err.message); }
};
const MAX_S = Number(process.env.RUN_MAX_S ?? 180);
setTimeout(() => { console.log("turn ended:", turnEnded); ws.close(); process.exit(turnEnded ? 0 : 1); }, MAX_S * 1000);
