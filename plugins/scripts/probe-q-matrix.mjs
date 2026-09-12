// probe-q-matrix.mjs：三场景实测——A=多问题(非多选) B=多问题(含多选) C=单个多选。
// 每个场景：真实触发 ask_user_question → 捕获真实帧 → ①模拟 App 现有点击/自动提交逻辑（精确复刻 QuestionCard），
// ②再发"用户本意"完整答案验证 DSH 接受度。只读直连 127.0.0.1:3080，不经 relay/E2EE。
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
  return { ok: j?.result?.ok === true, value: j?.result?.value, error: j?.result?.error };
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 精确复刻 App QuestionCard 的点击/自动提交逻辑（drafts + maybeSubmit）。 */
function simulateAppClicks(qs) {
  const drafts = new Map();
  const log = [];
  let submitted = false;
  let autoSubmitAnswer = null;
  const itemIdOf = (q) => q.id ?? "";
  const maybeSubmit = () => {
    const complete = qs.every((q) => {
      const d = drafts.get(itemIdOf(q));
      return d != null && (d.selected.length > 0 || (d.custom ?? "").trim() !== "");
    });
    if (!complete) return;
    submitted = true;
    autoSubmitAnswer = { answers: qs.map((q) => { const d = drafts.get(itemIdOf(q)) ?? { selected: [], custom: null }; return { id: q.id, selected: [...d.selected], ...(d.custom ? { custom: d.custom } : {}) }; }) };
    log.push(`>>> 自动提交触发（最后一击）→ ${JSON.stringify(autoSubmitAnswer)}`);
  };
  for (const q of qs) {
    for (const opt of (q.options ?? [])) {
      const id = itemIdOf(q);
      const cur = drafts.get(id) ?? { selected: [], custom: null };
      const newSel = q.multiSelect === true
        ? (cur.selected.includes(opt.label) ? cur.selected.filter((l) => l !== opt.label) : [...cur.selected, opt.label])
        : [opt.label];
      drafts.set(id, { selected: newSel, custom: null });
      log.push(`点击 ${id} → [${newSel.join(",")}]`);
      maybeSubmit();
      if (submitted) return { submitted, autoSubmitAnswer, log };
    }
  }
  // 全点完仍未自动提交（存在无法用选项作答的题等）
  return { submitted, autoSubmitAnswer, log };
}

const SCENARIOS = [
  {
    name: "A·多问题（非多选）",
    prompt: "请调用 ask_user_question 工具，一次问我两个问题，都是单选：第一个 options 为 A、B，第二个 options 为 C、D。问题尽量简短。",
    intended: (qs) => ({ answers: qs.map((q, i) => ({ id: q.id, selected: [(q.options ?? [])[i === 0 ? 0 : 1]?.label ?? "A"] })) }),
  },
  {
    name: "B·多问题（含多选）",
    prompt: "请调用 ask_user_question 工具，一次问我两个问题：第一个是单选（options: A、B）；第二个是多选（multi_select 为 true，options: X、Y、Z）。问题尽量简短。",
    intended: (qs) => ({ answers: qs.map((q) => ({ id: q.id, selected: q.multiSelect === true ? (q.options ?? []).map((o) => o.label).slice(0, 2) : [(q.options?.[0]?.label ?? "A")] })) }),
  },
  {
    name: "C·单个多选",
    prompt: "请调用 ask_user_question 工具，问我一个多选问题（multi_select 为 true），options 为 X、Y、Z。问题尽量简短。",
    intended: (qs) => ({ answers: qs.map((q) => ({ id: q.id, selected: (q.options ?? []).map((o) => o.label).slice(0, 2) })) }),
  },
];

console.log("[0] 准备：建会话 + 连 mux/$events");
const created = await unary("session/create", { request: {} });
if (!created.ok) { console.log("session/create 失败:", JSON.stringify(created)); process.exit(1); }
const sessionId = created.value.sessionId;
console.log("  会话:", sessionId);

let eventsClientId = "";
const waterfallQueue = [];
let waterfallWake = null;
const ws = new WebSocket(`ws://${AUTHORITY}/api/remote.mux`, { headers: { cookie } });
ws.onmessage = (ev) => {
  const f = JSON.parse(ev.data);
  if (f.type !== "item" || f.value == null) return;
  const v = f.value;
  if (v.type === "ready") eventsClientId = v.clientId;
  else if (v.type === "waterfall" && v.event === "user-questions/request" && v.agentId === sessionId) {
    waterfallQueue.push(v);
    waterfallWake?.();
    waterfallWake = null;
  }
};
await new Promise((resolve) => {
  ws.onopen = () => ws.send(JSON.stringify({ type: "open", streamId: randomUUID(), endpoint: "$events", payload: { args: {} } }));
  const t = setTimeout(resolve, 15000);
  const poll = setInterval(() => { if (eventsClientId) { clearTimeout(t); clearInterval(poll); resolve(); } }, 100);
});
console.log("  $events ready, clientId:", eventsClientId);

async function waitWaterfall(timeoutMs = 90000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    if (waterfallQueue.length > 0) return waterfallQueue.shift();
    await new Promise((r) => { waterfallWake = r; setTimeout(r, 500); });
  }
  return null;
}

const results = [];
for (const sc of SCENARIOS) {
  console.log(`\n======== ${sc.name} ========`);
  console.log("[1] 触发提问");
  const run = await unary("session/prompt", { request: { requestId: randomUUID(), sessionId, mode: "queue", content: [{ type: "text", text: sc.prompt }] } });
  if (!run.ok) { console.log("  prompt 失败:", JSON.stringify(run)); continue; }

  const wf = await waitWaterfall();
  if (!wf) { console.log("  TIMEOUT：未收到提问瀑布（agent 可能未调用工具）"); continue; }
  const qs = wf.request.questions ?? [];
  console.log(`  收到 ${qs.length} 题:`, qs.map((q) => `${q.id}(multi=${q.multiSelect === true},opts=${q.options?.length ?? 0})`).join(" | "));

  console.log("[2] 模拟 App 现有点击/自动提交逻辑");
  const sim = simulateAppClicks(qs);
  for (const l of sim.log) console.log("   ", l);
  if (sim.submitted) console.log("  ★ 结果：提前自动提交（用户没机会答完）——当前行为");
  else console.log("  ★ 结果：全点完仍未提交（卡死，只能跳过）——当前行为");

  console.log("[3] 发送『用户本意』的完整答案，验证 DSH 接受度");
  const intended = sc.intended(qs);
  console.log("   应答值:", JSON.stringify(intended));
  const ar = await unary("$events/result", { clientId: eventsClientId, eventId: wf.eventId, outcome: { kind: "result", value: intended } });
  console.log("   $events/result 接受:", ar.ok === true, ar.ok ? "" : JSON.stringify(ar.error));
  await sleep(8000); // 等 agent 收尾，避免下一题混入
  results.push({ scenario: sc.name, questions: qs.length, multiSelect: qs.some((q) => q.multiSelect === true), appAutoSubmitted: sim.submitted, dshAcceptsIntended: ar.ok === true });
}

console.log("\n======== 汇总 ========");
for (const r of results) {
  console.log(`${r.scenario}: 题数=${r.questions} 含多选=${r.multiSelect} | App当前行为=${r.appAutoSubmitted ? "提前自动提交" : "卡死"} | DSH接受本意答案=${r.dshAcceptsIntended}`);
}
try { ws.close(); } catch {}
process.exit(0);
