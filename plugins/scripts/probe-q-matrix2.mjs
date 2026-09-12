// probe-q-matrix2.mjs：第二轮实测矩阵（补全文本题场景）。
// 每场景：真实触发 ask_user_question → 捕获真实帧 →
//   ① 模拟【当前 App】QuestionCard 逻辑（选项点击自动提交 + 全局 customText 恒写第一题）
//   ② 模拟【拟修复】逻辑（多选/文本题不自动提交 + 显式提交按钮 + 每题独立输入）
//   ③ 发送用户本意答案 → 验证 DSH 接受度。
// 只读直连 127.0.0.1:3080，不经 relay/E2EE。
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
const now = Date.now();
const body = b64url(Buffer.from(JSON.stringify({ version: 1, authority: AUTHORITY, issuedAt: now, expiresAt: now + 86400e3 }), "utf8"));
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

const itemIdOf = (q) => q.id ?? "";
function answerOf(qs, drafts) {
  return { answers: qs.map((q) => { const d = drafts.get(itemIdOf(q)) ?? { selected: [], custom: null }; return { id: q.id, selected: [...d.selected], ...(d.custom ? { custom: d.custom } : {}) }; }) };
}

/** 当前 App 逻辑：选项点击→maybeSubmit 自动提交；「提交输入」恒写第一题。 */
function simulateCurrent(qs, actions) {
  const drafts = new Map();
  const log = [];
  let submitted = false;
  let out = null;
  const maybeSubmit = () => {
    const complete = qs.every((q) => { const d = drafts.get(itemIdOf(q)); return d != null && (d.selected.length > 0 || (d.custom ?? "").trim() !== ""); });
    if (!complete) return;
    submitted = true;
    out = answerOf(qs, drafts);
    log.push(`>>> 自动提交 → ${JSON.stringify(out)}`);
  };
  for (const a of actions) {
    if (submitted) break;
    if (a.kind === "click") {
      const q = qs.find((x) => x.id === a.id);
      const cur = drafts.get(a.id) ?? { selected: [], custom: null };
      const newSel = q?.multiSelect === true
        ? (cur.selected.includes(a.label) ? cur.selected.filter((l) => l !== a.label) : [...cur.selected, a.label])
        : [a.label];
      drafts.set(a.id, { selected: newSel, custom: null });
      log.push(`点击 ${a.id}→[${newSel.join(",")}]`);
      maybeSubmit();
    } else if (a.kind === "custom") {
      // 全局输入框 → 恒写第一题（并清其 selected）
      const firstId = itemIdOf(qs[0]);
      drafts.set(firstId, { selected: [], custom: a.text });
      log.push(`「提交输入」→ custom 写入第一题 ${firstId}（覆盖其选项）`);
      maybeSubmit();
    }
  }
  return { submitted, out, log };
}

/** 拟修复逻辑：含多选/文本题的批次不自动提交；每题独立输入；显式提交。 */
function simulateFixed(qs, actions) {
  const drafts = new Map();
  const log = [];
  let submitted = false;
  let out = null;
  const completeNow = () => qs.every((q) => { const d = drafts.get(itemIdOf(q)); return d != null && (d.selected.length > 0 || (d.custom ?? "").trim() !== ""); });
  const hasMultiOrText = qs.some((q) => q.multiSelect === true || (q.options ?? []).length === 0);
  for (const a of actions) {
    if (a.kind === "click") {
      const q = qs.find((x) => x.id === a.id);
      const cur = drafts.get(a.id) ?? { selected: [], custom: null };
      const newSel = q?.multiSelect === true
        ? (cur.selected.includes(a.label) ? cur.selected.filter((l) => l !== a.label) : [...cur.selected, a.label])
        : [a.label];
      drafts.set(a.id, { selected: newSel, custom: null });
      log.push(`点击 ${a.id}→[${newSel.join(",")}]`);
      // 仅纯选项+全单选的批次保留"答完即发"
      if (!hasMultiOrText) {
        const complete = completeNow();
        if (complete) { submitted = true; out = answerOf(qs, drafts); log.push(`>>> 答完自动提交（保留基线行为）→ ${JSON.stringify(out)}`); }
      }
    } else if (a.kind === "custom") {
      drafts.set(a.id, { selected: [], custom: a.text }); // 每题独立输入
      log.push(`输入 ${a.id} → custom`);
    } else if (a.kind === "submit") {
      const complete = completeNow();
      if (complete) { submitted = true; out = answerOf(qs, drafts); log.push(`>>> 显式提交 → ${JSON.stringify(out)}`); }
      else log.push(">>> 提交按钮不可用（仍有题未答）");
    }
  }
  return { submitted, out, log };
}

const SCENARIOS = [
  {
    name: "A·多题全单选（基线）",
    prompt: "请调用 ask_user_question 一次问我两个单选问题：第一题 options 为 A1、A2；第二题 options 为 B1、B2。问题尽量简短。",
    actions: [{ kind: "click", id: "q1", label: "A1" }, { kind: "click", id: "q2", label: "B1" }],
    intended: (qs) => ({ answers: qs.map((q, i) => ({ id: q.id, selected: [(q.options ?? [])[0]?.label ?? "A1"] })) }),
  },
  {
    name: "B·多题含多选",
    prompt: "请调用 ask_user_question 一次问我两个问题：第一题单选（options: 甲、乙）；第二题多选（multi_select 为 true，options: X、Y、Z）。问题尽量简短。",
    actions: [
      { kind: "click", id: "q1", label: "甲" },
      { kind: "click", id: "q2", label: "X" },
      { kind: "click", id: "q2", label: "Y" }, // 用户想选两项
      { kind: "submit" },
    ],
    intended: (qs) => ({ answers: qs.map((q) => ({ id: q.id, selected: q.multiSelect === true ? (q.options ?? []).map((o) => o.label).slice(0, 2) : [(q.options?.[0]?.label ?? "甲")] })) }),
  },
  {
    name: "C·单个多选",
    prompt: "请调用 ask_user_question 问我一个多选问题（multi_select 为 true），options 为 X、Y、Z。问题尽量简短。",
    actions: [
      { kind: "click", id: "q1", label: "X" },
      { kind: "click", id: "q1", label: "Y" },
      { kind: "submit" },
    ],
    intended: (qs) => ({ answers: qs.map((q) => ({ id: q.id, selected: (q.options ?? []).map((o) => o.label).slice(0, 2) })) }),
  },
  {
    name: "D1·文本题在前 + 单选（报告#4 基线）",
    prompt: "请调用 ask_user_question 一次问我两个问题：第一题是纯文本回答（不要给 options，问\"写一句备注\"）；第二题单选（options: 普通选项、另一个选项）。",
    actions: [
      { kind: "custom", id: "q1", text: "备注内容" },
      { kind: "click", id: "q2", label: "普通选项" },
    ],
    intended: (qs) => ({ answers: qs.map((q, i) => i === 0 ? { id: q.id, selected: [], custom: "备注内容" } : { id: q.id, selected: [(q.options?.[0]?.label ?? "普通选项")] }) }),
  },
  {
    name: "D2·单选在前 + 文本题在后（报告#15/16 卡死场景）",
    prompt: "请调用 ask_user_question 一次问我两个问题：第一题单选（options: 普通选项、另一个选项）；第二题是纯文本回答（不要给 options，问\"写一句备注\"）。",
    actions: [
      { kind: "click", id: "q1", label: "普通选项" },
      { kind: "custom", id: "q2", text: "备注内容" }, // 当前App这里实际写入第一题
      { kind: "submit" },
    ],
    intended: (qs) => ({ answers: qs.map((q, i) => i === 0 ? { id: q.id, selected: [(q.options?.[0]?.label ?? "普通选项")] } : { id: q.id, selected: [], custom: "备注内容" }) }),
  },
  {
    name: "E·单题纯文本（基线）",
    prompt: "请调用 ask_user_question 问我一个纯文本问题（不要给 options），问题简短。",
    actions: [{ kind: "custom", id: "q1", text: "测试回答" }],
    intended: (qs) => ({ answers: qs.map((q) => ({ id: q.id, selected: [], custom: "测试回答" })) }),
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
console.log("  $events ready:", eventsClientId);

async function waitWaterfall(timeoutMs = 90000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    if (waterfallQueue.length > 0) return waterfallQueue.shift();
    await new Promise((r) => { waterfallWake = r; setTimeout(r, 500); });
  }
  return null;
}

const rows = [];
for (const sc of SCENARIOS) {
  console.log(`\n======== ${sc.name} ========`);
  const run = await unary("session/prompt", { request: { requestId: randomUUID(), sessionId, mode: "queue", content: [{ type: "text", text: sc.prompt }] } });
  if (!run.ok) { console.log("  prompt 失败:", JSON.stringify(run)); continue; }
  const wf = await waitWaterfall();
  if (!wf) { console.log("  TIMEOUT 未收到提问"); continue; }
  const qs = wf.request.questions ?? [];
  console.log(`  真实帧 ${qs.length} 题:`, qs.map((q) => `${q.id}(multi=${q.multiSelect === true},opts=${q.options?.length ?? 0})`).join(" | "));

  // 用真实 id 重映射动作
  const remap = sc.actions.map((a, i) => {
    if (a.kind === "click") { const q = qs[i === 0 ? 0 : Math.min(i, qs.length - 1)]; return { ...a, id: q.id, label: a.label }; }
    if (a.kind === "custom") { const q = qs[Math.min(i, qs.length - 1)]; return { ...a, id: q.id }; }
    return a;
  });

  console.log("  【当前 App 行为】");
  const cur = simulateCurrent(qs, remap);
  for (const l of cur.log) console.log("   ", l);
  if (cur.submitted) console.log("   → 提交了:", JSON.stringify(cur.out));
  else console.log("   → 卡死：提交无效，只能跳过 ❌");

  console.log("  【拟修复逻辑】");
  const fix = simulateFixed(qs, remap);
  for (const l of fix.log) console.log("   ", l);
  if (fix.submitted) console.log("   → 提交成功:", JSON.stringify(fix.out));
  else console.log("   → 仍未提交（动作序列本身未完成）");

  const intended = sc.intended(qs);
  const ar = await unary("$events/result", { clientId: eventsClientId, eventId: wf.eventId, outcome: { kind: "result", value: intended } });
  console.log("  【DSH 对本意答案】", ar.ok === true ? "✅ 接受" : `❌ ${JSON.stringify(ar.error)}`);
  await sleep(8000);
  rows.push({ scenario: sc.name, current: cur.submitted ? "提交(可能残缺)" : "卡死", fixed: fix.submitted ? "正常提交" : "未提交", dsh: ar.ok === true });
}

console.log("\n======== 汇总 ========");
for (const r of rows) console.log(`${r.scenario} | 当前App=${r.current} | 拟修复=${r.fixed} | DSH接受本意=${r.dsh ? "✅" : "❌"}`);
try { ws.close(); } catch {}
process.exit(0);
