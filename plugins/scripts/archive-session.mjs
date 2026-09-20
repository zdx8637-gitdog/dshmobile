// 归档会话（清理只读探针留下的临时会话用）。
// 用法：node scripts/archive-session.mjs <sessionId>      # 归档指定会话
//       node scripts/archive-session.mjs --newest-idle    # 归档"最新的非活跃会话"（不碰你正在用的）
//       node scripts/archive-session.mjs --list           # 列出归档集合
//
// ⚠️ 2026-09-20 事故后加固：探针脚本曾因"不带参数取 sessions[0]"把目标指到用户**正在使用的会话**，
//    随后一次归档就让它从 GUI 主列表里消失（DSH 没有取消归档接口，只能改状态文件 + 重启 DSH）。
//    因此本脚本默认**拒绝归档最近 10 分钟仍在写入的会话**，必须显式加 --force 才允许。
import { existsSync, readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { DshClient } from "file:///D:/p/dshmobile-plugin/bridge/dsh.js";

const DSH_BASE = process.env.DSHMOBILE_DSH_URL || "http://127.0.0.1:3080";
const STATE_DIR = process.env.DSHMOBILE_STATE_DIR || join(homedir(), ".dsh-mobile");
const SESS_ROOT = join(homedir(), ".dsh", "sessions");
const LIVE_WINDOW_MS = 10 * 60 * 1000;
const arg = process.argv[2];
const force = process.argv.includes("--force");

/**
 * 会话日志的最后写入时间。
 * ⚠️ 不能按"脚本自己的 cwd"推算分桶（DSH 的分桶取决于**会话自己的**工作目录）——
 * 2026-09-20 就是因为这个，护栏把活跃会话误判为"非活跃"而放行。
 * 这里改为在 ~/.dsh/sessions 的各个分桶下直接找该会话的日志文件。
 */
function lastWriteMs(sessionId) {
  try {
    for (const bucketDir of readdirSync(SESS_ROOT)) {
      const dir = join(SESS_ROOT, bucketDir, sessionId);
      for (const n of ["session.v3.jsonl.zstd", "session.jsonl.zstd"]) {
        const p = join(dir, n);
        if (existsSync(p)) return statSync(p).mtimeMs;
      }
    }
  } catch { /* 忽略 */ }
  return 0;
}

const dsh = new DshClient(DSH_BASE, { stateDir: STATE_DIR, token: "" });
await dsh.ensureProtocol();
if (dsh.protocol !== "v2") throw new Error("只支持 v2（新版 DSH）");

const list = await dsh.unary("session/list", { _request: {} });
const sessions = (list?.value?.items ?? []).filter((s) => (s.origin ?? "session") !== "subagent");

if (!arg || arg === "--list") {
  console.log(`当前会话 ${sessions.length} 个（* = 最近 10 分钟仍在写入，勿归档）：`);
  for (const s of sessions) {
    const age = Date.now() - lastWriteMs(s.sessionId);
    console.log(`  ${age < LIVE_WINDOW_MS ? "*" : " "} ${s.sessionId}  ${s.title ?? ""}`);
  }
  process.exit(0);
}

let sessionId = arg;
if (sessionId === "--newest-idle") {
  const idle = sessions.filter((s) => Date.now() - lastWriteMs(s.sessionId) >= LIVE_WINDOW_MS);
  if (!idle.length) { console.log("没有非活跃会话可归档"); process.exit(0); }
  sessionId = idle[0].sessionId;
  console.log(`选中最新非活跃会话：${sessionId}`);
}

const age = Date.now() - lastWriteMs(sessionId);
if (age < LIVE_WINDOW_MS && !force) {
  console.error(`拒绝：${sessionId} 在 ${Math.round(age / 1000)}s 前仍在写入（很可能正在使用中，归档后 GUI 列表将看不到它）。`);
  console.error("确认要归档请加 --force；只想清理临时会话可用 --newest-idle。");
  process.exit(1);
}

const r = await dsh.unary("workspace/archiveSession", { request: { sessionId } }, { timeoutMs: 30000 });
console.log(r.ok ? `✅ 已归档 ${sessionId}` : `❌ 归档失败：${JSON.stringify(r.error)}`);
await new Promise((res) => setTimeout(res, 150));
process.exitCode = r.ok ? 0 : 1;
