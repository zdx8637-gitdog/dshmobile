// 模拟浏览器调试台的确切流程：登录 → devices → WS(子协议 bearer) → sessions.list → 打印结果
const RELAY = "https://www.deepseek-claudex.cn";
const loginRes = await fetch(`${RELAY}/auth/login`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ username: "dshtest", password: process.env.TEST_PASS ?? "" }) });
const login = await loginRes.json();
console.log("login ok:", login.ok, "token len:", login.data?.accessToken?.length);
const devRes = await fetch(`${RELAY}/devices`, { headers: { authorization: `Bearer ${login.data.accessToken}` } });
const dev = await devRes.json();
const online = (dev.data || []).find((d) => d.status === "online") || (dev.data || [])[0];
console.log("device:", online?.label, online?.status);

const ws = new WebSocket(`${RELAY.replace(/^https/, "wss")}/ws/client?targetDeviceId=${online.id}&clientId=sim-${Date.now()}`, ["bearer", login.data.accessToken]);
const pending = new Map();
const done = new Promise((resolve, reject) => {
  const to = setTimeout(() => reject(new Error("timeout waiting for sessions.list response")), 15000);
  ws.onmessage = (ev) => {
    const env = JSON.parse(ev.data);
    if ((env.kind === "response" || env.kind === "error") && pending.has(env.requestId)) {
      clearTimeout(to);
      resolve(env);
    }
  };
  ws.onopen = () => {
    const requestId = "sim-" + Math.random().toString(36).slice(2, 10);
    pending.set(requestId, 1);
    console.log("ws open, sending sessions.list requestId=", requestId);
    ws.send(JSON.stringify({ schemaVersion: 1, kind: "request", envelopeId: requestId, type: "sessions.list", sentAt: new Date().toISOString(), requestId, actor: { role: "client", clientId: "sim" }, target: { deviceId: online.id }, payload: {} }));
  };
  ws.onerror = (e) => reject(new Error("ws error"));
  ws.onclose = () => reject(new Error("ws closed early"));
});
try {
  const env = await done;
  const sessions = env.payload?.data?.sessions || [];
  console.log("sessions.list response:", env.payload?.ok ? `ok, ${sessions.length} sessions` : JSON.stringify(env.payload));
  console.log("first 3:", sessions.slice(0, 3).map((s) => `${s.projections?.values?.title ?? s.sessionId.slice(0, 8)} [${s.running ? "run" : "idle"}]`).join(" | "));
} catch (e) {
  console.log("FAIL:", e.message);
  process.exit(1);
}
ws.close();
process.exit(0);
