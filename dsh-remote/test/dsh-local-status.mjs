// 直连本地 DSH 查会话状态（只读，安全）。响应形状: {result:{ok,value:{items}}}
const BASE = "http://127.0.0.1:3080";
const resp = await fetch(`${BASE}/api/session.list`, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ type: "client-request", rpcId: "ls1", method: "session.list", payload: {} }),
});
const r = await resp.json();
const items = r.result?.value?.items ?? [];
const running = items.filter((s) => s.running);
console.log("total sessions:", items.length, "| running:", running.length);
for (const s of running) {
  console.log("RUNNING:", s.sessionId);
  console.log("  cwd:", s.cwd, "| title:", s.projections?.values?.title);
  console.log("  goal:", JSON.stringify(s.projections?.values?.goal?.goal?.id), "rev", s.projections?.values?.goal?.goal?.revision);
  console.log("  stats:", JSON.stringify(s.projections?.values?.sessionStats));
}
