// 归档（或列出后归档）指定会话：用于清理只读探针留下的临时会话。
// 用法：node scripts/archive-session.mjs <sessionId>      # 归档指定会话
//       node scripts/archive-session.mjs --last           # 归档当前列出的最后一个会话
import { DshClient } from "../bridge/dsh.js";
import { homedir } from "node:os";
import { join } from "node:path";

const DSH_BASE = process.env.DSHMOBILE_DSH_URL || "http://127.0.0.1:3080";
const STATE_DIR = process.env.DSHMOBILE_STATE_DIR || join(homedir(), ".dsh-mobile");
const arg = process.argv[2];

const dsh = new DshClient(DSH_BASE, { stateDir: STATE_DIR, token: "" });
await dsh.ensureProtocol();
if (dsh.protocol !== "v2") throw new Error("只支持 v2（新版 DSH）");

let sessionId = arg;
if (!sessionId || sessionId === "--last") {
  const list = await dsh.unary("session/list", { _request: {} });
  const items = list?.value?.items ?? list?.value?.sessions ?? [];
  if (!items.length) { console.log("没有会话可归档"); process.exit(0); }
  sessionId = items[items.length - 1]?.sessionId ?? items[items.length - 1]?.id;
  console.log(`选中最后一个会话：${sessionId}`);
}

const r = await dsh.unary("workspace/archiveSession", { request: { sessionId } }, { timeoutMs: 30000 });
console.log(r.ok ? `✅ 已归档 ${sessionId}` : `❌ 归档失败：${JSON.stringify(r.error)}`);
// 让 WS/keepalive 句柄自然收尾，避免直接 process.exit 触发 libuv 断言（噪声非零退出）
await new Promise((res) => setTimeout(res, 150));
process.exitCode = r.ok ? 0 : 1;
