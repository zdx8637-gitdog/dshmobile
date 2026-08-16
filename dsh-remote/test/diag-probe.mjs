// 诊断：列出会话 + 看指定会话的历史事件类型
// 目标设备：label === "DSH Bridge (windows-p)"（本地 CLI bridge）
const RELAY = "https://www.deepseek-claudex.cn";
const loginRes = await fetch(`${RELAY}/auth/login`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ username: "dshtest", password: process.env.TEST_PASS ?? "" }) });
const login = await loginRes.json();
const devRes = await fetch(`${RELAY}/devices`, { headers: { authorization: `Bearer ${login.data.accessToken}` } });
const dev = await devRes.json();
const online = (dev.data || []).find((d) => d.status === "online" && d.label === "DSH Bridge (windows-p)");
if (!online) { console.log("NO ONLINE DEVICE (DSH Bridge (windows-p))"); process.exit(1); }
const ws = new WebSocket(`${RELAY.replace(/^https/, "wss")}/ws/client?targetDeviceId=${online.id}&clientId=diag-${Date.now()}`, ["bearer", login.data.accessToken]);
const pending = new Map();
function send(type, payload) {
  return new Promise((resolve, reject) => {
    const requestId = "r-" + Math.random().toString(36).slice(2, 10);
    const timer = setTimeout(() => { pending.delete(requestId); reject(new Error("timeout " + type)); }, 20000);
    pending.set(requestId, (e) => { clearTimeout(timer); resolve(e); });
    ws.send(JSON.stringify({ schemaVersion: 1, kind: "request", envelopeId: requestId, type, sentAt: new Date().toISOString(), requestId, actor: { role: "client", clientId: "diag" }, target: { deviceId: online.id }, payload }));
  });
}
ws.onmessage = (ev) => {
  const e = JSON.parse(ev.data);
  if (pending.has(e.requestId)) { pending.get(e.requestId)(e); pending.delete(e.requestId); }
};
ws.onopen = async () => {
  try {
    const list = await send("sessions.list", {});
    const sessions = list.payload?.data?.sessions ?? [];
    console.log("sessions:", sessions.length);
    for (const s of sessions) console.log(" -", s.sessionId, "running=", s.running, "blank=", s.blank, "origin=", s.origin ?? "-");

    const target = process.argv[2];
    if (target) {
      const hist = await send("sessions.history", { sessionId: target, maxMessages: 100 });
      const events = hist.payload?.data?.events ?? [];
      console.log("history", target, ": ok=", hist.payload?.ok, "events=", events.length, "err=", JSON.stringify(hist.payload?.error));
      for (const e of events) {
        const t = e.event?.type;
        if (t && !["assistant/chunk", "step/start", "step/end"].includes(t)) {
          console.log(" ev:", t, JSON.stringify(e.event?.data ?? {}).slice(0, 140));
        }
      }
    }
  } catch (err) {
    console.log("FAIL:", err.message);
  }
  ws.close();
  process.exit(0);
};
setTimeout(() => process.exit(2), 30000);