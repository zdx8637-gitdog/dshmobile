// 读取 DSH **宿主内存里的归档集合**（只读，用与桥完全相同的路径：mux → workspace/follow 基线）。
// 用途：判断某个会话是否仍被宿主视为"已归档"——这是决定"改完状态文件要不要重启 DSH"的唯一权威依据。
//
// 背景见 docs/dsh-session-archive.md（2026-09-20 误归档事故）。
// 用法：node scripts/probe-session-archive.mjs [sessionId]
import { DshClient } from "../bridge/dsh.js";
import { homedir } from "node:os";
import { join } from "node:path";
import { readFileSync } from "node:fs";

const DSH_BASE = process.env.DSHMOBILE_DSH_URL || "http://127.0.0.1:3080";
const STATE_DIR = process.env.DSHMOBILE_STATE_DIR || join(homedir(), ".dsh-mobile");
const WS_FILE = join(homedir(), ".dsh", "storages", "workspace.json");
const wanted = process.argv[2] ?? null;

const dsh = new DshClient(DSH_BASE, { stateDir: STATE_DIR, token: "" });
await dsh.ensureProtocol();
const mux = dsh.openMux(() => {});

let baseline = null;
mux
  .openStream("workspace/follow", {}, {
    onItem: (value) => {
      const v = value?.value ?? value;
      if (v && Array.isArray(v.archivedSessionIds)) baseline = v;
    },
    onError: (e) => console.error("  workspace/follow error:", String(e?.message ?? e)),
  })
  .catch((e) => console.error("  openStream failed:", String(e?.message ?? e)));

for (let i = 0; i < 40 && !baseline; i++) await new Promise((r) => setTimeout(r, 250));

if (!baseline) {
  console.log("❌ 15s 内没拿到 workspace/follow 基线（DSH 未运行？Cookie 失效？）");
} else {
  const host = baseline.archivedSessionIds;
  let file = [];
  try { file = JSON.parse(readFileSync(WS_FILE, "utf8"))?.global?.archivedSessionIds ?? []; } catch { /* 忽略 */ }
  console.log(`宿主内存归档集合：${host.length} 条`);
  console.log(`磁盘文件归档集合：${file.length} 条`);
  const onlyHost = host.filter((x) => !file.includes(x));
  if (onlyHost.length) {
    console.log(`⚠️ 宿主比磁盘多 ${onlyHost.length} 条（说明宿主内存态未重载；改过文件后需重启 DSH）：`);
    for (const x of onlyHost) console.log(`    ${x}`);
  } else {
    console.log("✅ 宿主与磁盘一致（无需重启即可反映文件改动）");
  }
  if (wanted) {
    console.log(`\n查询 ${wanted}`);
    console.log(`  宿主视为已归档：${host.includes(wanted) ? "是 ❌（GUI 列表里看不到）" : "否 ✅"}`);
    console.log(`  磁盘视为已归档：${file.includes(wanted) ? "是" : "否"}`);
  }
}
await new Promise((r) => setTimeout(r, 150));
process.exit(0);   // mux 的 WS 会拖住事件循环，必须显式退出
