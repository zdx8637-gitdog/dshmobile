// probe-multiq.mjs：只读验证——用本机 credentials 锻造合法 Cookie，直连运行中的真实 DSH，
// 触发 ask_user_question「多问题 + 多选」批次，捕获真实帧形状，并用 App 同款答案形状应答，
// 验证 DSH 侧是否接受（区分"DSH 拒绝答案"与"App 端提交逻辑"两种故障）。
// 不经过 relay/E2EE，不碰手机配对。
import { createHash, createHmac, randomUUID } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const b64url = (buf) => Buffer.from(buf).toString("base64").replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/u, "");

function readBrowserSecret(candidates) {
  for (const file of candidates) {
    if (!existsSync(file)) continue;
    let lines;
    try { lines = readFileSync(file, "utf8").split(/\r?\n/); } catch { continue; }
    let inRecord = false;
    for (const line of lines) {
      if (/client-connection[^\n]*browser-session|browser-session[^\n]*client-connection/.test(line)) inRecord = true;
      else if (inRecord && /^\S/.test(line) && !/^\s/.test(line) && !/secret|payload|kind|version/.test(line)) inRecord = false;
      if (inRecord) {
        const m = /^\s*secret:\s*"?([A-Za-z0-9_-]{30,})"?\s*$/.exec(line);
        if (m) return m[1];
      }
    }
  }
  return null;
}

const home = homedir();
const secret = readBrowserSecret([join(home, ".dsh", ".credentials.yaml"), join(home, ".dsh", "profiles", "web", ".credentials.yaml")]);
if (!secret) { console.log("SKIP: 无 browser-session 记录"); process.exit(0); }

const AUTHORITY = "127.0.0.1:3080";
const cookieName = "dsh-auth-" + b64url(createHash("sha256").update(AUTHORITY).digest());
const issuedAt = Date.now();
const expiresAt = issuedAt + 24 * 3600e3;
const body = b64url(Buffer.from(JSON.stringify({ version: 1, authority: AUTHORITY, issuedAt, expiresAt }), "utf8"));
const cookie = `${cookieName}=v1.${body}.${b64url(createHmac("sha256", Buffer.from(secret, "base64url")).update(body).digest())}`;

const base = `http://${AUTHORITY}`;
const headers = { cookie, "content-type": "application/json" };

async function unary(endpoint, args) {
  const rpcId = randomUUID();
  const res = await fetch(`${base}/api/${endpoint}`, {
    method: "POST", headers,
    body: JSON.stringify({ type: "client-request", rpcId, method: endpoint, payload: { args } }),
  });
  const j = await res.json().catch(() => ({}));
  return { status: res.status, ok: j?.result?.ok === true, value: j?.result?.value, error: j?.result?.error };
}

const PROMPT_MULTI = "请调用 ask_user_question 工具，一次问我两个问题：第一个是单选（options: A=方案一, B=方案二），第二个是多选（multi_select=true, options: X, Y, Z）。问题尽量简短。";
let failures = 0;
const check = (n, c, e = "") => {
  if (c) console.log("  PASS", n);
  else { failures += 1; console.log("  FAIL", n, e); }
};

console.log("[1] 建临时会话 + 触发多问题/多选提问");
const created = await unary("session/create", { request: {} });
if (!created.ok) { console.log("session/create 失败:", JSON.stringify(created)); process.exit(1); }
const sessionId = created.value.sessionId;
console.log("  会话:", sessionId);

const run = await unary("session/prompt", { request: { requestId: randomUUID(), sessionId, mode: "queue", content: [{ type: "text", text: PROMPT_MULTI }] } });
check("prompt 已受理", run.ok === true, JSON.stringify(run));

console.log("[2] 连 remote.mux → $events，等 user-questions/request 瀑布");
let eventsClientId = "";
let waterfall = null;
let sawTurnEnd = false;
const observedEvents = [];
const ws = new WebSocket(`ws://${AUTHORITY}/api/remote.mux`, { headers: { cookie } });
ws.onmessage = (ev) => {
  const f = JSON.parse(ev.data);
  if (f.type !== "item" || f.value == null) return;
  const v = f.value;
  if (v.type === "ready") {
    eventsClientId = v.clientId;
    console.log("  $events ready, clientId:", eventsClientId);
  } else if (v.type === "waterfall" && v.event === "user-questions/request") {
    waterfall = v;
    console.log("\n  收到提问瀑布 eventId:", v.eventId);
    console.log("  真实 questions 形状:", JSON.stringify(v.request.questions, null, 2));
  } else if (v.type === "emit" && v.event === "api-session/activity") {
    /* 忽略 */
  }
};
await new Promise((resolve) => {
  ws.onopen = () => ws.send(JSON.stringify({ type: "open", streamId: randomUUID(), endpoint: "$events", payload: { args: {} } }));
  const t = setTimeout(resolve, 90000);
  const poll = setInterval(() => { if (waterfall) { clearTimeout(t); clearInterval(poll); resolve(); } }, 200);
});

if (!waterfall) { console.log("TIMEOUT: 90s 内未收到提问（agent 可能没调用工具）"); process.exit(1); }
const qs = waterfall.request.questions ?? [];
check("多问题批次（questions ≥ 2）", qs.length >= 2, `len=${qs.length}`);
const multiQ = qs.find((q) => q.multiSelect === true);
check("含 multiSelect 问题", Boolean(multiQ), JSON.stringify(qs.map((q) => ({ id: q.id, multi: q.multiSelect, opts: q.options?.length }))));

console.log("\n[3] 用 App 同款答案形状应答（多选提交多个 label）");
const answer = { answers: qs.map((q) => ({ id: q.id, selected: q.multiSelect === true ? (q.options ?? []).map((o) => o.label).slice(0, 2) : [(q.options?.[0]?.label ?? "A")] })) };
console.log("  应答值:", JSON.stringify(answer));
const ar = await unary("$events/result", { clientId: eventsClientId, eventId: waterfall.eventId, outcome: { kind: "result", value: answer } });
check("$events/result 被接受", ar.ok === true, JSON.stringify(ar));

console.log("\n[4] 观察 agent 是否接受答案继续（等待会话 follow 的 turn/end 或工具结果）");
const followStreamId = randomUUID();
let accepted = false;
let rejectedMsg = "";
ws.onmessage = (ev) => {
  const f = JSON.parse(ev.data);
  if (f.type !== "item" || f.value == null) return;
  const v = f.value;
  if (v.type === "snapshot") { /* 忽略 */ }
  else if (v.type === "event" && v.event?.type === "tool/result") {
    try {
      const txt = JSON.stringify(v.event?.data ?? {});
      if (txt.includes("answers")) { accepted = true; console.log("  agent 收到答案（tool/result 含 answers）"); }
      else if (txt.length > 0) { console.log("  tool/result:", txt.slice(0, 200)); }
    } catch {}
  } else if (v.type === "event" && v.event?.type === "turn/end") {
    sawTurnEnd = true;
    console.log("  turn/end");
  }
};
if (ws.readyState === WebSocket.OPEN) {
  ws.send(JSON.stringify({ type: "open", streamId: followStreamId, endpoint: "session/follow", payload: { args: { request: { address: { kind: "session", sessionId } } } } }));
}
await new Promise((resolve) => setTimeout(resolve, 30000));
check("DSH 接受多问题/多选答案（agent 收到 answers）", accepted, rejectedMsg);
console.log("\n==== 汇总 ====");
console.log("问题数:", qs.length, "| 多选问题:", qs.map((q) => `${q.id}(multi=${q.multiSelect === true},opts=${q.options?.length ?? 0})`).join(" "));
try { ws.close(); } catch {}
console.log(failures === 0 ? "ALL PASS" : `${failures} FAILURES`);
process.exit(failures === 0 ? 0 : 1);
