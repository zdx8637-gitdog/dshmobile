// 验证盘符根目录失败路径：sessions.create {cwd:"D:\\"} 不应误注册 D:\ 工作区
const RELAY = "https://www.deepseek-claudex.cn";
const login = await (await fetch(RELAY + "/auth/login", {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ username: "dshtest", password: process.env.TEST_PASS ?? "" }),
})).json();
const dev = await (await fetch(RELAY + "/devices", { headers: { authorization: "Bearer " + login.data.accessToken } })).json();
const online = (dev.data || []).find((d) => d.status === "online" && d.label === "DSH Bridge (windows-p)");
const ws = new WebSocket(RELAY.replace(/^https/, "wss") + "/ws/client?targetDeviceId=" + online.id + "&clientId=dw2-" + Date.now(), ["bearer", login.data.accessToken]);
const pending = new Map();
function send(type, payload) {
  return new Promise((res) => {
    const id = "r-" + Math.random().toString(36).slice(2, 9);
    pending.set(id, res);
    ws.send(JSON.stringify({ schemaVersion: 1, kind: "request", envelopeId: id, type, sentAt: new Date().toISOString(), requestId: id, actor: { role: "client", clientId: "dw2" }, target: { deviceId: online.id }, payload }));
  });
}
ws.onmessage = (ev) => {
  const e = JSON.parse(ev.data);
  if (pending.has(e.requestId)) { pending.get(e.requestId)(e); pending.delete(e.requestId); }
};
ws.onopen = async () => {
  const s = await send("sessions.create", { cwd: "D:\\" });
  console.log("create(cwd D:\\):", JSON.stringify(s.payload));
  const w = await send("workspace.list", {});
  console.log("workspaces:", JSON.stringify((w.payload?.data?.items ?? []).map((x) => x.path)));
  ws.close();
  process.exit(0);
};
setTimeout(() => { console.log("timeout"); process.exit(2); }, 60000);
