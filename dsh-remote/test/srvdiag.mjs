// 在服务器上直连 relay（绕开 nginx）测试大 history 响应
const RELAY = "http://127.0.0.1:48730";
const loginRes = await fetch(`${RELAY}/auth/login`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ username: "dshtest", password: process.env.TEST_PASS ?? "" }) });
const login = await loginRes.json();
const devRes = await fetch(`${RELAY}/devices`, { headers: { authorization: `Bearer ${login.data.accessToken}` } });
const dev = await devRes.json();
const online = (dev.data || []).find((d) => d.status === "online");
const target = process.argv[2] || "60396e55-aa0c-484b-b30e-aa0e8caef938";
const ws = new WebSocket(`${RELAY.replace(/^http/, "ws")}/ws/client?targetDeviceId=${online.id}&clientId=srvdiag-${Date.now()}`, ["bearer", login.data.accessToken]);
const t0 = Date.now();
ws.onmessage = (ev) => {
  const size = typeof ev.data === "string" ? ev.data.length : ev.data.byteLength;
  let env = null;
  try { env = JSON.parse(ev.data); } catch {}
  console.log(`[${Date.now() - t0}ms] kind=${env?.kind} type=${env?.type} size=${size}`);
  if (env?.type === "sessions.history") {
    console.log("events:", env.payload?.data?.events?.length);
    process.exit(0);
  }
};
ws.onopen = () => {
  const requestId = "srvdiag-" + Math.random().toString(36).slice(2, 10);
  ws.send(JSON.stringify({ schemaVersion: 1, kind: "request", envelopeId: requestId, type: "sessions.history", sentAt: new Date().toISOString(), requestId, actor: { role: "client", clientId: "srvdiag" }, target: { deviceId: online.id }, payload: { sessionId: target } }));
  console.log("sent:", requestId, "target:", target.slice(0, 13));
};
setTimeout(() => { console.log("TIMEOUT 20s"); process.exit(1); }, 20000);
