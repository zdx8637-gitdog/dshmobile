// 验证命令通道：commands.list + commands.execute（/plan + /permission）
const RELAY = "https://www.deepseek-claudex.cn";
const loginRes = await fetch(`${RELAY}/auth/login`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ username: "dshtest", password: process.env.TEST_PASS ?? "" }) });
const login = await loginRes.json();
const devRes = await fetch(`${RELAY}/devices`, { headers: { authorization: `Bearer ${login.data.accessToken}` } });
const dev = await devRes.json();
const online = (dev.data || []).find((d) => d.status === "online");
const ws = new WebSocket(`${RELAY.replace(/^https/, "wss")}/ws/client?targetDeviceId=${online.id}&clientId=cmdprobe-${Date.now()}`, ["bearer", login.data.accessToken]);
const pending = new Map();
function send(type, payload) {
  return new Promise((resolve) => {
    const requestId = "r-" + Math.random().toString(36).slice(2, 10);
    pending.set(requestId, resolve);
    ws.send(JSON.stringify({ schemaVersion: 1, kind: "request", envelopeId: requestId, type, sentAt: new Date().toISOString(), requestId, actor: { role: "client", clientId: "cmdprobe" }, target: { deviceId: online.id }, payload }));
  });
}
ws.onmessage = (ev) => {
  const e = JSON.parse(ev.data);
  if (pending.has(e.requestId)) { pending.get(e.requestId)(e); pending.delete(e.requestId); }
};
ws.onopen = async () => {
  const list = await send("sessions.list", {});
  const sessions = list.payload.data.sessions;
  const target = sessions.find((s) => s.blank === false && !s.running);
  console.log("target:", target.sessionId.slice(0, 16));

  const cl = await send("commands.list", { sessionId: target.sessionId });
  console.log("commands.list:", cl.payload?.ok ? cl.payload.data.commands.map((c) => `${c.name}[${c.input?.hint ?? ""}]`).join(", ") : JSON.stringify(cl.payload?.error));

  const pl = await send("commands.execute", { sessionId: target.sessionId, line: "/plan" });
  console.log("execute /plan:", pl.payload?.ok ? JSON.stringify(pl.payload.data?.result) : JSON.stringify(pl.payload?.error));

  const poff = await send("commands.execute", { sessionId: target.sessionId, line: "/plan off" });
  console.log("execute /plan off:", poff.payload?.ok ? JSON.stringify(poff.payload.data?.result) : JSON.stringify(poff.payload?.error));

  const perm = await send("commands.execute", { sessionId: target.sessionId, line: "/permission" });
  console.log("execute /permission:", perm.payload?.ok ? JSON.stringify(perm.payload.data?.result) : JSON.stringify(perm.payload?.error));

  ws.close();
  process.exit(0);
};
setTimeout(() => { console.log("TIMEOUT"); process.exit(1); }, 40000);
