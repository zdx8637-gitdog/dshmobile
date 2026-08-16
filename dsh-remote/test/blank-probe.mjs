// 空白会话时序验证：create → 不 prompt → 等 N 秒 → prompt
const RELAY = "https://www.deepseek-claudex.cn";
const DELAY_S = Number(process.argv[2] ?? 60);
const loginRes = await fetch(`${RELAY}/auth/login`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ username: "dshtest", password: process.env.TEST_PASS ?? "" }) });
const login = await loginRes.json();
const devRes = await fetch(`${RELAY}/devices`, { headers: { authorization: `Bearer ${login.data.accessToken}` } });
const dev = await devRes.json();
const online = (dev.data || []).find((d) => d.status === "online");
const ws = new WebSocket(`${RELAY.replace(/^https/, "wss")}/ws/client?targetDeviceId=${online.id}&clientId=bp-${Date.now()}`, ["bearer", login.data.accessToken]);
const pending = new Map();
function send(type, payload) {
  return new Promise((resolve, reject) => {
    const requestId = "r-" + Math.random().toString(36).slice(2, 10);
    const timer = setTimeout(() => { pending.delete(requestId); reject(new Error("timeout " + type)); }, 20000);
    pending.set(requestId, (e) => { clearTimeout(timer); resolve(e); });
    ws.send(JSON.stringify({ schemaVersion: 1, kind: "request", envelopeId: requestId, type, sentAt: new Date().toISOString(), requestId, actor: { role: "client", clientId: "bp" }, target: { deviceId: online.id }, payload }));
  });
}
ws.onmessage = (ev) => {
  const e = JSON.parse(ev.data);
  if (pending.has(e.requestId)) { pending.get(e.requestId)(e); pending.delete(e.requestId); }
};
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
ws.onopen = async () => {
  try {
    const created = await send("sessions.create", {});
    const sid = created.payload?.data?.sessionId;
    console.log("created blank:", sid);
    await send("events.subscribe", { sessionId: sid });
    const l1 = await send("sessions.list", {});
    console.log("in list right after create:", (l1.payload?.data?.sessions ?? []).some((s) => s.sessionId === sid) ? "yes" : "NO");
    console.log("waiting", DELAY_S, "s (blank, no prompt)...");
    await wait(DELAY_S * 1000);
    const l2 = await send("sessions.list", {});
    console.log("in list after delay:", (l2.payload?.data?.sessions ?? []).some((s) => s.sessionId === sid) ? "yes" : "NO");
    const p = await send("sessions.run", { sessionId: sid, content: [{ type: "text", text: "回复：好" }] });
    console.log("prompt after blank delay:", p.payload?.ok ? "accepted" : JSON.stringify(p.payload?.error));
  } catch (err) { console.log("FAIL:", err.message); }
  ws.close();
  process.exit(0);
};
setTimeout(() => process.exit(2), DELAY_S * 1000 + 40000);
