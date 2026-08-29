// 宿主半边冒烟：走真实本地 HTTP 通道（隔离 state 目录与端口），
// 跑通 保存配置 → 桥启动 → pair 出码 → 注册 → 退出登录 全链路。
// 用法：node scripts/smoke-host.mjs <relayUser> <relayPass>
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const [username, password] = process.argv.slice(2);
if (!username || !password) {
  console.error("usage: node scripts/smoke-host.mjs <relayUser> <relayPass>");
  process.exit(1);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const PORT = 19000 + Math.floor(Math.random() * 800);
const STATE = mkdtempSync(path.join(tmpdir(), "dshmobile-smoke-"));

process.env.DSHMOBILE_STATE_DIR = STATE;
process.env.DSHMOBILE_HTTP_PORT = String(PORT);
const { apply } = await import("../lib/index.js");

const ctx = {};
const dispose = apply(ctx, {});

const get = async () => (await fetch(`http://127.0.0.1:${PORT}/state`)).json();
const act = async (action, payload) =>
  (await fetch(`http://127.0.0.1:${PORT}/action`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ action, payload }),
  })).json();

console.log("t0 initial bridgeStatus:", JSON.stringify((await get()).data.bridgeStatus));

// 无凭据启动 → 应自动出 grant 授权码（常驻二维码，无需账号）
await sleep(3000);
let s = (await get()).data;
console.log("t1 grant code:", JSON.stringify({ mode: s.mode, code: s.pairingCode }));
if (!/^\d{6}$/.test(s.pairingCode)) {
  console.error("GRANT CODE FAILED");
  dispose();
  process.exit(1);
}

// 保存账号密码 → 桥启动 + 转 pair 登录码
await act("save", {
  relayUrl: "https://www.deepseek-claudex.cn",
  username,
  password,
  deviceLabel: "DSH Bridge (smoke)",
});
await sleep(4000);
s = (await get()).data;
console.log("t2 after save:", JSON.stringify({ status: s.bridgeStatus, mode: s.mode, code: s.pairingCode }));
if (s.bridgeStatus !== "running") {
  console.error("BRIDGE START FAILED");
  dispose();
  process.exit(1);
}
if (!/^\d{6}$/.test(s.pairingCode)) {
  console.error("PAIR CODE FAILED");
  dispose();
  process.exit(1);
}

// 注册新账号（与旧冒烟一致，会生成垃圾账号）
const freshU = "smoke" + Math.random().toString(36).slice(2, 10);
const freshP = "Smoke" + Math.random().toString(36).slice(2, 10);
await act("register", { username: freshU, password: freshP });
await sleep(5000);
s = (await get()).data;
console.log("t3 after register:", JSON.stringify({ user: s.username, error: s.registerError, status: s.bridgeStatus }));
if (s.registerError) {
  console.error("REGISTER FAILED");
  dispose();
  process.exit(1);
}

// 退出登录 → 停桥 + 回 grant 模式
await act("logout");
await sleep(2500);
s = (await get()).data;
console.log("t4 after logout:", JSON.stringify({ status: s.bridgeStatus, mode: s.mode, user: s.username }));
if (s.bridgeStatus !== "stopped" || s.mode !== "grant") {
  console.error("LOGOUT FAILED");
  dispose();
  process.exit(1);
}

dispose();
rmSync(STATE, { recursive: true, force: true });
console.log("SMOKE OK");
process.exit(0);
