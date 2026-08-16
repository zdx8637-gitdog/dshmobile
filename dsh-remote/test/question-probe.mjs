// 触发提问：让 agent 用 ask_user 工具问一个问题（目标：本地 CLI bridge）
// 用法: node question-probe.mjs [sessionId]
const RELAY = "https://www.deepseek-claudex.cn";
const loginRes = await fetch(`${RELAY}/auth/login`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ username: "dshtest", password: process.env.TEST_PASS ?? "" }) });
const login = await loginRes.json();
const devRes = await fetch(`${RELAY}/devices`, { headers: { authorization: `Bearer ${login.data.accessToken}` } });
const dev = await devRes.json();
const online = (dev.data || []).find((d) => d.status === "online" && d.label === "DSH Bridge (windows-p)");
if (!online) { console.log("NO ONLINE DEVICE"); process.exit(1); }
const ws = new WebSocket(`${RELAY.replace(/^https/, "wss")}/ws/client?targetDeviceId=${online.id}&clientId=qt-${Date.now()}`, ["bearer", login.data.accessToken]);
const pending = new Map();
function send(type, payload) {
  return new Promise((resolve) => {
    const requestId = "r-" + Math.random().toString(36).slice(2, 10);
    pending.set(requestId, resolve);
    ws.send(JSON.stringify({ schemaVersion: 1, kind: "request", envelopeId: requestId, type, sentAt: new Date().toISOString(), requestId, actor: { role: "client", clientId: "qt" }, target: { deviceId: online.id }, payload }));
  });
}
let gotQuestion = false;
ws.onmessage = (ev) => {
  const e = JSON.parse(ev.data);
  if (pending.has(e.requestId)) { pending.get(e.requestId)(e); pending.delete(e.requestId); return; }
  if (e.kind === "event" && e.payload?.frame?.type === "question/requested") {
    gotQuestion = true;
    console.log("QUESTION RECEIVED:", JSON.stringify(e.payload.frame.questions).slice(0, 300));
    console.log("QUESTION RPCID:", e.payload.rpcId);
  }
  if (e.kind === "event" && e.payload?.frame?.type === "question/resolved") {
    console.log("QUESTION RESOLVED (client answered/skipped)");
  }
};
ws.onopen = async () => {
  // 目标会话：argv 传入（手机端正订阅着它）或新建
  let sid = process.argv[2];
  if (!sid) {
    const created = await send("sessions.create", {});
    sid = created.payload?.data?.sessionId ?? created.payload?.data?.id;
    console.log("created session:", sid);
    await send("events.subscribe", { sessionId: sid });
  }
  console.log("target session:", sid);
  await send("events.subscribe", { sessionId: sid });
  const resp = await send("sessions.run", { sessionId: sid, content: [{ type: "text", text: "请使用 ask_user 工具问我一个二选一的问题：今天喝咖啡还是喝茶？选项为咖啡和茶。只问这一个问题即可。" }] });
  console.log("prompt:", resp.payload?.ok ? "accepted" : JSON.stringify(resp.payload?.error));
};
setTimeout(() => { console.log("question seen:", gotQuestion); ws.close(); process.exit(gotQuestion ? 0 : 1); }, 60000);