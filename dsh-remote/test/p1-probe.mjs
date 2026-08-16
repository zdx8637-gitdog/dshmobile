// 验证 P1 消息：session.models（目录）与 session.selectModel（选择）
const RELAY = "https://www.deepseek-claudex.cn";
const loginRes = await fetch(`${RELAY}/auth/login`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ username: "dshtest", password: process.env.TEST_PASS ?? "" }) });
const login = await loginRes.json();
const devRes = await fetch(`${RELAY}/devices`, { headers: { authorization: `Bearer ${login.data.accessToken}` } });
const dev = await devRes.json();
const online = (dev.data || []).find((d) => d.status === "online");
const ws = new WebSocket(`${RELAY.replace(/^https/, "wss")}/ws/client?targetDeviceId=${online.id}&clientId=p1probe-${Date.now()}`, ["bearer", login.data.accessToken]);
const pending = new Map();
function send(type, payload) {
  return new Promise((resolve) => {
    const requestId = "r-" + Math.random().toString(36).slice(2, 10);
    pending.set(requestId, resolve);
    ws.send(JSON.stringify({ schemaVersion: 1, kind: "request", envelopeId: requestId, type, sentAt: new Date().toISOString(), requestId, actor: { role: "client", clientId: "p1probe" }, target: { deviceId: online.id }, payload }));
  });
}
ws.onmessage = (ev) => {
  const e = JSON.parse(ev.data);
  if (pending.has(e.requestId)) { pending.get(e.requestId)(e); pending.delete(e.requestId); }
};
ws.onopen = async () => {
  // 1. 列表找一个远程测试会话
  const list = await send("sessions.list", {});
  const sessions = list.payload.data.sessions;
  const target = sessions.find((s) => s.blank === false) ;
  console.log("target session:", target.sessionId.slice(0, 16));

  // 2. session.models
  const models = await send("session.models", { sessionId: target.sessionId });
  if (models.payload?.ok) {
    const d = models.payload.data;
    console.log("current selection:", JSON.stringify(d.current));
    console.log("routable:", d.routable);
    for (const g of d.groups) {
      console.log(` provider [${g.id}] ${g.name}: ${g.models.length} models`);
      for (const m of g.models.slice(0, 3)) {
        const efforts = m.reasoning?.efforts?.map((x) => x.id).join(",") ?? "-";
        console.log(`   - ${m.id} (efforts: ${efforts}, default: ${m.reasoning?.defaultEffort ?? "-"})`);
      }
    }
    for (const f of d.failures ?? []) console.log(" FAILURE:", f.id, f.message);
  } else {
    console.log("models FAIL:", JSON.stringify(models.payload?.error));
  }

  // 3. selectModel 保持当前选择（幂等回写，验证写路径）
  if (models.payload?.ok) {
    const cur = models.payload.data.current;
    const sel = await send("session.selectModel", { sessionId: target.sessionId, provider: cur.provider, model: cur.model, ...(cur.reasoningEffort ? { reasoningEffort: cur.reasoningEffort } : {}) });
    console.log("selectModel:", sel.payload?.ok ? "ok -> " + JSON.stringify(sel.payload.data?.selected) : "FAIL " + JSON.stringify(sel.payload?.error));
  }
  ws.close();
  process.exit(0);
};
setTimeout(() => { console.log("TIMEOUT"); process.exit(1); }, 40000);
