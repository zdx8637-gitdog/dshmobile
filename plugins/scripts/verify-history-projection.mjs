// verify-history-projection.mjs：用**真实 DSH** + 桥的真实投影函数，验证 B1/B2 是否生效。
//   B1：assistant/message 的 reasoning 块被剥离
//   B2：tool/result 内层文本被截断 + 带 toolSummary 摘要 + toolResult.full 能取回全文
// 与 smoke 的区别：不 mock DSH、不 mock 数据，直接吃真实 session/page 的记录。
// 只读：不创建会话、不写状态目录（复用桥已缓存的 Cookie）、不经 relay/E2EE。
//
// 用法: node scripts/verify-history-projection.mjs [sessionId]
import { existsSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { Adapter } from "../bridge/adapter.js";
import { DshClient } from "../bridge/dsh.js";

const STATE_DIR = process.env.DSHMOBILE_STATE_DIR || join(homedir(), ".dsh-mobile");
const DSH_BASE = process.env.DSHMOBILE_DSH_URL || "http://127.0.0.1:3080";

const dsh = new DshClient(DSH_BASE, { stateDir: STATE_DIR, token: "" });
const responses = [];
const fakeRelay = {
  url: "http://relay.invalid",
  deviceToken: "unused",
  respond: (requestId, type, payload) => responses.push({ requestId, type, payload }),
  forwardEvent: () => {},
  send: () => true,
};
const adapter = new Adapter({ dsh, relay: fakeRelay, workspaceRoot: join(STATE_DIR, "deliveries"), e2ee: null });

const list = await dsh.unary("session/list", { _request: {} });
if (!list.ok) {
  console.error("session/list 失败（DSH 未运行或 Cookie 失效）:", JSON.stringify(list.error));
  process.exit(1);
}
const sessions = (list.value?.items ?? []).filter((s) => (s.origin ?? "session") !== "subagent");

/**
 * 目标选择（2026-09-20 事故后加固）：
 * 曾因"不带参数 → 取 sessions[0]"，把这个探针**指到了用户正在用的那个会话**
 * （列表第一个＝最新活跃），后续一次误归档就把它从 GUI 列表里隐藏了。
 * 现在：默认**排除最近 10 分钟仍在写入的活跃会话**；要用活跃会话必须显式给 id + --allow-live。
 */
const LIVE_WINDOW_MS = 10 * 60 * 1000;
const SESS_ROOT = join(homedir(), ".dsh", "sessions");
function lastWriteMs(sessionId) {
  try {
    const dir = join(SESS_ROOT, "--D-p--", sessionId);   // 当前工作区（D:\p）分桶
    const f = ["session.v3.jsonl.zstd", "session.jsonl.zstd"].map((n) => join(dir, n)).find((p) => existsSync(p));
    return f ? statSync(f).mtimeMs : 0;
  } catch {
    return 0;
  }
}
const allowLive = process.argv.includes("--allow-live");
const wanted = process.argv[2] && !process.argv[2].startsWith("--") ? process.argv[2] : null;
let target;
if (wanted) {
  target = sessions.find((s) => s.sessionId === wanted);
  if (!target) { console.error(`找不到会话 ${wanted}`); process.exit(1); }
  const age = Date.now() - lastWriteMs(target.sessionId);
  if (age < LIVE_WINDOW_MS && !allowLive) {
    console.error(`拒绝：${wanted} 在 ${Math.round(age / 1000)}s 前还在写入（可能正在使用中）。`);
    console.error("如确认要用它，请加 --allow-live。");
    process.exit(1);
  }
} else {
  target = sessions.find((s) => Date.now() - lastWriteMs(s.sessionId) >= LIVE_WINDOW_MS);
  if (!target) { console.error("没有可用的非活跃会话（可用 --allow-live 或显式传 sessionId）"); process.exit(1); }
  console.log(`（未指定 sessionId：已自动跳过最近 ${LIVE_WINDOW_MS / 60000} 分钟内活跃的会话）`);
}
const sessionId = target?.sessionId;
console.log("protocol:", dsh.protocol, "| 本次只读分析目标 session:", sessionId, "| 本探针只读，不写任何状态");

// 真实投影路径：需要 mux 提供 session/follow 游标
const mux = dsh.openMux(() => {});
adapter.attachMux(mux);
await new Promise((r) => setTimeout(r, 1500)); // 等 $events/workspace 基线就绪

const MAX = 50;
await adapter.handleRequest({ requestId: "v1", type: "sessions.history", payload: { sessionId, maxMessages: MAX } });
const res = responses.find((r) => r.requestId === "v1");
if (!res?.payload?.ok) {
  console.error("history 失败:", JSON.stringify(res?.payload?.error));
  process.exit(1);
}
const wire = res.payload.data.events ?? [];
const wireBytes = Buffer.byteLength(JSON.stringify(res.payload.data));

// 同一游标下的原始记录（未投影）用于对比
const cursor = adapter.sessionFollows.get(sessionId)?.cursor ?? -1;
const raw = await dsh.unary("session/page", { request: { address: { kind: "session", sessionId }, throughSeq: cursor, maxMessages: MAX } }, { timeoutMs: 60000 });
const rawRecords = (raw.value?.records ?? []).filter((r) => r?.type === "event" && r.event);
const rawEvents = rawRecords.map((r) => r.event);
// 只比"事件本体"字节（剔除 {event,seq} 包装与 projections，才是同口径）
const rawEventBytes = rawEvents.reduce((n, e) => n + Buffer.byteLength(JSON.stringify(e)), 0);
const wireEventBytes = wire.reduce((n, w) => n + Buffer.byteLength(JSON.stringify(w.event)), 0);
const droppedBytes = rawEvents
  .filter((e) => ["assistant/chunk", "step/start", "step/end"].includes(e.type))
  .reduce((n, e) => n + Buffer.byteLength(JSON.stringify(e)), 0);

const kb = (n) => (n / 1024).toFixed(0) + " KB";
let reasoningBlocks = 0;
let rawReasoningBlocks = 0;
for (const e of rawEvents) {
  for (const b of e?.data?.message?.content ?? []) if (b?.type === "reasoning") rawReasoningBlocks += 1;
}
for (const w of wire) {
  for (const b of w?.event?.data?.message?.content ?? []) if (b?.type === "reasoning") reasoningBlocks += 1;
}

const trWire = wire.filter((w) => w.event?.type === "tool/result").map((w) => w.event);
const trRaw = rawEvents.filter((e) => e.type === "tool/result");
let innerMax = 0;
let withSummary = 0;
let truncated = 0;
for (const e of trWire) {
  const summary = e.data?.toolSummary;
  if (summary) withSummary += 1;
  if (summary?.truncated) truncated += 1;
  for (const block of e.data?.message?.content ?? []) {
    for (const b of block?.content ?? []) {
      if (b?.type === "text" && typeof b.text === "string") innerMax = Math.max(innerMax, b.text.length);
    }
  }
}
let rawInnerBytes = 0;
for (const e of trRaw) {
  for (const block of e.data?.message?.content ?? []) {
    for (const b of block?.content ?? []) if (b?.type === "text" && typeof b.text === "string") rawInnerBytes += Buffer.byteLength(b.text);
  }
}
let wireInnerBytes = 0;
for (const e of trWire) {
  for (const block of e.data?.message?.content ?? []) {
    for (const b of block?.content ?? []) if (b?.type === "text" && typeof b.text === "string") wireInnerBytes += Buffer.byteLength(b.text);
  }
}

console.log("\n=== 结果（真实 DSH，maxMessages=" + MAX + "）===");
console.log(`事件数: 原始 ${rawEvents.length} → 投影后 ${wire.length}（丢弃流式碎片 ${rawEvents.length - wire.length} 条 = ${kb(droppedBytes)}）`);
console.log(`事件本体体积: 原始 ${kb(rawEventBytes)} → 投影后 ${kb(wireEventBytes)}  （省 ${(100 - (wireEventBytes / rawEventBytes) * 100).toFixed(1)}%）`);
console.log(`B1 reasoning 块: 原始 ${rawReasoningBlocks} 个 → 投影后 ${reasoningBlocks} 个 ${reasoningBlocks === 0 ? "✓" : "✗"}`);
console.log(`B2 tool/result: ${trWire.length} 条；内层文本最大 ${innerMax} 字符；带 toolSummary ${withSummary} 条（其中标记截断 ${truncated} 条）`);
console.log(`B2 工具文本体积: ${kb(rawInnerBytes)} → ${kb(wireInnerBytes)}  （省 ${rawInnerBytes ? (100 - (wireInnerBytes / rawInnerBytes) * 100).toFixed(1) : "0"}%）`);
console.log(`（响应整体含包装与 projections: ${kb(wireBytes)}）`);

// B2c：toolResult.full 取回全文
const cached = trWire.find((e) => e.data?.toolSummary?.truncated);
const callId = cached?.data?.toolSummary?.callId ?? cached?.data?.message?.source?.callId;
if (callId) {
  await adapter.handleRequest({ requestId: "v2", type: "toolResult.full", payload: { sessionId, callId } });
  const full = responses.find((r) => r.requestId === "v2");
  const previewLen = cached.data.toolSummary.preview?.length ?? 0;
  const fullLen = full?.payload?.data?.text?.length ?? 0;
  console.log(`B2c toolResult.full: callId=${callId} 摘要 ${previewLen} 字符 → 全文 ${fullLen} 字符 ${fullLen > previewLen ? "✓" : "✗"}`);
} else {
  console.log("B2c 跳过：本页没有超过阈值的工具输出");
}
try { mux.close?.(); } catch {}
process.exit(0);
