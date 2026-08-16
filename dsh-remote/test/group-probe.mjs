// 验证：sessions.create {cwd} 应自动注册/解析工作区，会话以 workspaceId 建（web 端归入同名分组）
const RELAY = "https://www.deepseek-claudex.cn";
const login = await (await fetch(RELAY + "/auth/login", {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ username: "dshtest", password: process.env.TEST_PASS ?? "" }),
})).json();
const dev = await (await fetch(RELAY + "/devices", { headers: { authorization: "Bearer " + login.data.accessToken } })).json();
const online = (dev.data || []).find((d) => d.status === "online" && d.label === "DSH Bridge (windows-p)");
if (!online) { console.log("bridge offline"); process.exit(1); }
const ws = new WebSocket(RELAY.replace(/^https/, "wss") + "/ws/client?targetDeviceId=" + online.id + "&clientId=dw1-" + Date.now(), ["bearer", login.data.accessToken]);
const pending = new Map();
function send(type, payload) {
  return new Promise((res) => {
    const id = "r-" + Math.random().toString(36).slice(2, 9);
    pending.set(id, res);
    ws.send(JSON.stringify({ schemaVersion: 1, kind: "request", envelopeId: id, type, sentAt: new Date().toISOString(), requestId: id, actor: { role: "client", clientId: "dw1" }, target: { deviceId: online.id }, payload }));
  });
}
ws.onmessage = (ev) => {
  const e = JSON.parse(ev.data);
  if (pending.has(e.requestId)) { pending.get(e.requestId)(e); pending.delete(e.requestId); }
};
ws.onopen = async () => {
  // 场景1：cwd=D:\p —— 应解析到既有工作区「p」（created:false），会话记入其 sessionIds
  const s1 = await send("sessions.create", { cwd: "D:\\p" });
  console.log("create(cwd D:\\p):", JSON.stringify(s1.payload));
  // 场景2：cwd=D:\p\__grouptest__ —— 应新建工作区「__grouptest__」
  const s2 = await send("sessions.create", { cwd: "D:\\p\\__grouptest__" });
  console.log("create(cwd __grouptest__):", JSON.stringify(s2.payload));
  const w = await send("workspace.list", {});
  const wsList = w.payload?.data?.items ?? [];
  console.log("workspaces now:", JSON.stringify(wsList.map((x) => ({ id: x.workspaceId, path: x.path, title: x.title, sessions: x.sessionIds?.length })), null, 1));
  const testWs = wsList.find((x) => x.path === "D:\\p\\__grouptest__");
  const pWs = wsList.find((x) => x.path === "D:\\p");
  console.log("D:\\p accounts s1?", pWs?.sessionIds?.includes(s1.payload?.data?.sessionId), "| __grouptest__ accounts s2?", testWs?.sessionIds?.includes(s2.payload?.data?.sessionId));
  ws.close();
  process.exit(0);
};
setTimeout(() => { console.log("timeout"); process.exit(2); }, 60000);
