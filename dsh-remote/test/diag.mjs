// 精简诊断：只发 history，记录收到的每帧大小与时间
const RELAY = "https://www.deepseek-claudex.cn";
const loginRes = await fetch(`${RELAY}/auth/login`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ username: "dshtest", password: process.env.TEST_PASS ?? "" }) });
const login = await loginRes.json();
const devRes = await fetch(`${RELAY}/devices`, { headers: { authorization: `Bearer ${login.data.accessToken}` } });
const dev = await devRes.json();
const online = (dev.data || []).find((d) => d.status === "online");
const ws = new WebSocket(`${RELAY.replace(/^https/, "wss")}/ws/client?targetDeviceId=${online.id}&clientId=diag-${Date.now()}`, ["bearer", login.data.accessToken]);
let gotHistory = false;
const targetSession = process.argv[2] || "session-bd7aa249-e56f-46f7-acec-425732451f73";
ws.onmessage = (ev) => {
  const t = Date.now();
  let env;
  try { env = JSON.parse(ev.data); } catch { console.log(`[${t - t0}ms] non-JSON frame, size=${ev.data.length ?? ev.data.byteLength}`); return; }
  const size = (typeof ev.data === "string" ? ev.data.length : ev.data.byteLength);
  console.log(`[${t - t0}ms] kind=${env.kind} type=${env.type} requestId=${env.requestId?.slice(0, 10)} size=${size}`);
  if (env.type === "sessions.history") {
    gotHistory = true;
    console.log("  events:", env.payload?.data?.events?.length, "payloadSize:", size);
    ws.close();
    process.exit(0);
  }
};
const t0 = Date.now();
ws.onopen = () => {
  console.log(`[0ms] ws open`);
  const requestId = "diag-" + Math.random().toString(36).slice(2, 10);
  ws.send(JSON.stringify({ schemaVersion: 1, kind: "request", envelopeId: requestId, type: "sessions.history", sentAt: new Date().toISOString(), requestId, actor: { role: "client", clientId: "diag" }, target: { deviceId: online.id }, payload: { sessionId: targetSession } }));
  console.log("sent history request:", requestId);
};
setTimeout(() => {
  if (!gotHistory) { console.log("TIMEOUT after 30s, no history response"); ws.close(); process.exit(1); }
}, 30000);
