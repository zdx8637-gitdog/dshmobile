// 归档 / 取消归档会话（DSH 只提供了 archiveSession，没有反向接口）。
//   node scripts/unarchive-session.mjs <sessionId>            # 取消归档（改宿主状态文件，需重启 DSH 生效）
//   node scripts/unarchive-session.mjs --list                 # 列出当前归档集合
//
// ⚠️ 两条重要说明：
// 1) **归档集合在 DSH 宿主进程内存里**（`workspaceRegistry`），持久化在 `~/.dsh/storages/workspace.json`。
//    改文件后必须**重启 DSH**（`dsh web`）才会重新加载；运行中的 DSH 不会重读该文件。
// 2) 归档**正在使用的会话**会让它在 GUI 主列表里消失（本次事故就是如此）——本脚本默认拒绝
//    归档最近 10 分钟仍在写入的会话，除非加 `--force`。
import { existsSync, readFileSync, statSync, writeFileSync, copyFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const WS = join(homedir(), ".dsh", "storages", "workspace.json");
const SESS_ROOT = join(homedir(), ".dsh", "sessions");
const LIVE_WINDOW_MS = 10 * 60 * 1000;

function readState() {
  return JSON.parse(readFileSync(WS, "utf8"));
}
/** DSH 的会话分桶名：D:\p → --D-p--（先去掉盘符冒号，再把分隔符换成 -）。 */
export function sessionBucket(dir) {
  return "--" + dir.replace(/[:\\/]+/g, "-").replace(/-+$/, "") + "--";
}
function lastWriteMs(sessionId) {
  try {
    const dir = join(SESS_ROOT, sessionBucket(process.cwd()), sessionId);
    for (const n of ["session.v3.jsonl.zstd", "session.jsonl.zstd"]) {
      const p = join(dir, n);
      if (existsSync(p)) return statSync(p).mtimeMs;
    }
  } catch { /* 找不到就当作非活跃 */ }
  return 0;
}

const arg = process.argv[2];

if (!arg || arg === "--list") {
  const ids = readState()?.global?.archivedSessionIds ?? [];
  console.log(`归档集合共 ${ids.length} 条（* = 最近 10 分钟仍在写入，可能是正在用的会话）：`);
  for (const id of ids) {
    const age = Date.now() - lastWriteMs(id);
    console.log(`  ${age < LIVE_WINDOW_MS ? "*" : " "} ${id}`);
  }
  console.log("\n取消归档：node scripts/unarchive-session.mjs <sessionId>（改文件后需重启 DSH）");
  process.exit(0);
}

const j = readState();
const ids = j?.global?.archivedSessionIds ?? [];
if (!ids.includes(arg)) {
  console.log(`ℹ️ ${arg} 不在归档集合里，无需处理。`);
  process.exit(0);
}
// 注意：取消归档是**安全动作**（它让会话重新可见），所以这里不拦"活跃会话"；
// 真正需要护栏的是归档那一侧，见 archive-session.mjs。
const age = Date.now() - lastWriteMs(arg);
if (age < LIVE_WINDOW_MS) console.log(`（提示：该会话 ${Math.round(age / 1000)}s 前仍在写入，可能正在使用中）`);
const backup = `${WS}.bak-${Date.now()}`;
copyFileSync(WS, backup);
j.global.archivedSessionIds = ids.filter((x) => x !== arg);
writeFileSync(WS, JSON.stringify(j, null, 2));
console.log(`✅ 已把 ${arg} 移出归档集合（${ids.length} → ${j.global.archivedSessionIds.length} 条）`);
console.log(`   备份：${backup}`);
console.log("   ⚠️ 归档集合在宿主内存里：**重启 DSH（dsh web）后**该会话才会重新出现在 GUI 列表。");
