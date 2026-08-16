// 验证分页语义：尾页 → beforeSeq 上一页 → 更早一页，检查 seq 边界与 hasMore
// 用法: node page-probe.mjs <sessionId>
const RELAY = "https://www.deepseek-claudex.cn";
const SID = process.argv[2] ?? "session-a6a330c4-c24f-4666-99c3-a8419f56070f";
const loginRes = await fetch(`${RELAY}/auth/login`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ username: "dshtest", password: process.env.TEST_PASS ?? "" }) });
const login = await loginRes.json();
const devRes = await fetch(`${RELAY}/devices`, { headers: { authorization: `Bearer ${login.data.accessToken}` } });
const dev = await devRes.json();
const online = (dev.data || []).find((d) => d.status === "online" && d.label === "DSH Bridge (windows-p)");
if (!online) { console.log("NO ONLINE DEVICE"); process.exit(1); }
const ws = new WebSocket(`${RELAY.replace(/^https/, "wss")}/ws/client?targetDeviceId=${online.id}&clientId=pp-${Date.now()}`, ["bearer", login.data.accessToken]);
const pending = new Map();
function send(type, payload) {
  return new Promise((resolve, reject) => {
    const requestId = "r-" + Math.random().toString(36).slice(2, 10);
    const timer = setTimeout(() => { pending.delete(requestId); reject(new Error("timeout " + type)); }, 30000);
    pending.set(requestId, (e) => { clearTimeout(timer); resolve(e); });
    ws.send(JSON.stringify({ schemaVersion: 1, kind: "request", envelopeId: requestId, type, sentAt: new Date().toISOString(), requestId, actor: { role: "client", clientId: "pp" }, target: { deviceId: online.id }, payload }));
  });
}
ws.onmessage = (ev) => {
  const e = JSON.parse(ev.data);
  if (pending.has(e.requestId)) { pending.get(e.requestId)(e); pending.delete(e.requestId); }
};
const summary = (label, resp) => {
  const data = resp.payload?.data ?? {};
  const events = data.events ?? [];
  const seqs = events.map((e) => e.seq).filter((s) => typeof s === "number");
  const min = seqs.length ? Math.min(...seqs) : null;
  const max = seqs.length ? Math.max(...seqs) : null;
  console.log(`${label}: events=${events.length} hasMore=${data.hasMore} seqRange=[${min}..${max}]`);
  return { min, max, hasMore: data.hasMore === true };
};
ws.onopen = async () => {
  try {
    const tail = summary("tail(10)", await send("sessions.history", { sessionId: SID, maxMessages: 10 }));
    const p2 = summary("page2(50, before tail.min)", await send("sessions.history", { sessionId: SID, beforeSeq: tail.min, maxMessages: 50 }));
    const p3 = summary("page3(50, before p2.min)", await send("sessions.history", { sessionId: SID, beforeSeq: p2.min, maxMessages: 50 }));
    const p4 = summary("page4(100, before p3.min)", await send("sessions.history", { sessionId: SID, beforeSeq: p3.min, maxMessages: 100 }));
    console.log("boundary check p2.max < tail.min:", p2.max !== null && tail.min !== null && p2.max < tail.min ? "OK" : "FAIL");
    console.log("boundary check p3.max < p2.min:", p3.max !== null && p2.min !== null && p3.max < p2.min ? "OK" : "FAIL");
    console.log("boundary check p4.max < p3.min:", p4.max !== null && p3.min !== null && p4.max < p3.min ? "OK" : "FAIL");
    // 一直翻到最老
    let before = p4.min;
    let pages = 0;
    let more = p4.hasMore;
    while (more && pages < 30) {
      const r = await send("sessions.history", { sessionId: SID, beforeSeq: before, maxMessages: 100 });
      const s = summary(`deep${pages}`, r);
      more = s.hasMore;
      if (s.min !== null) before = s.min;
      if (s.max === null && !s.hasMore) break;
      pages++;
    }
    console.log("deep pages until oldest:", pages, "final hasMore:", more);
  } catch (err) { console.log("FAIL:", err.message); }
  ws.close();
  process.exit(0);
};
setTimeout(() => process.exit(2), 60000);
