// 时序验证：create → prompt(立即) → 等 N 秒 → prompt 再试
const RELAY = "https://www.deepseek-claudex.cn";
const DELAY_S = Number(process.argv[2] ?? 30);
const loginRes = await fetch(`${RELAY}/auth/login`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ username: "dshtest", password: process.env.TEST_PASS ?? "" }) });
const login = await loginRes.json();
const devRes = await fetch(`${RELAY}/devices`, { headers: { authorization: `Bearer ${login.data.accessToken}` } });
const dev = await devRes.json();
const online = (dev.data || []).find((d) => d.status === "online");
const ws = new WebSocket(`${RELAY.replace(/^https/, "wss")}/ws/client?targetDeviceId=${online.id}&clientId=tp-${Date.now()}`, ["bearer", login.data.accessToken]);
const pending = new Map();
function send(type, payload) {
  return new Promise((resolve, reject) => {
    const requestId = "r-" + Math.random().toString(36).slice(2, 10);
    const timer = setTimeout(() => { pending.delete(requestId); reject(new Error("timeout " + type)); }, 20000);
    pending.set(requestId, (e) => { clearTimeout(timer); resolve(e); });
    ws.send(JSON.stringify({ schemaVersion: 1, kind: "request", envelopeId: requestId, type, sentAt: new Date().toISOString(), requestId, actor: { role: "client", clientId: "tp" }, target: { deviceId: online.id }, payload }));
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
    console.log("created:", sid);
    const p1 = await send("sessions.run", { sessionId: sid, content: [{ type: "text", text: "回复：好" }] });
    console.log("prompt#1 (immediate):", p1.payload?.ok ? "accepted" : JSON.stringify(p1.payload?.error));
    await wait(2000);
    const it = await send("sessions.interrupt", { sessionId: sid, reason: "timing test" });
    console.log("interrupt:", it.payload?.ok ? "ok" : JSON.stringify(it.payload?.error));
    console.log("waiting", DELAY_S, "s...");
    await wait(DELAY_S * 1000);
    const p2 = await send("sessions.run", { sessionId: sid, content: [{ type: "text", text: "回复：还在吗" }] });
    console.log("prompt#2 (after delay):", p2.payload?.ok ? "accepted" : JSON.stringify(p2.payload?.error));
    const list = await send("sessions.list", {});
    const found = (list.payload?.data?.sessions ?? []).find((s) => s.sessionId === sid);
    console.log("in session.list after delay:", found ? `yes running=${found.running} blank=${found.blank}` : "NO");
  } catch (err) { console.log("FAIL:", err.message); }
  ws.close();
  process.exit(0);
};
setTimeout(() => process.exit(2), DELAY_S * 1000 + 40000);
