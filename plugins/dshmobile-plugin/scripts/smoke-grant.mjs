// 宿主 grant 模式冒烟：mock settings scope，验证「未登录 → 匿名出码 → 手机授权 →
// 轮询取会话 → 桥启动（token 模式）→ 二维码转 pair 模式」全链路。
// 用法：node scripts/smoke-grant.mjs <phoneUser> <phonePass>
import { apply } from "../lib/index.js";
import { rmSync, existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const [phoneUser, phonePass] = process.argv.slice(2);
if (!phoneUser || !phonePass) {
  console.error("usage: node scripts/smoke-grant.mjs <phoneUser> <phonePass>");
  process.exit(1);
}

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const STATE_DIR = path.join(ROOT, "state");
const SESSION_FILE = path.join(STATE_DIR, "session.json");

// 清掉旧会话，保证从「未登录」开始
if (existsSync(SESSION_FILE)) rmSync(SESSION_FILE);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let value = {
  enabled: false,
  relayUrl: "https://www.deepseek-claudex.cn",
  username: "",
  password: "",
  deviceLabel: "DSH Bridge (smoke)",
  mode: "grant",
  pairingCode: "",
  pairingExpiresAt: "",
  grantPairingId: "",
  refreshPairing: false,
  bridgeStatus: "stopped",
  pairError: "",
  registerRequest: "",
  registerError: "",
};
const watchers = [];
const scope = {
  get: () => value,
  watch: (cb) => { watchers.push(cb); return () => {}; },
  update: async (patch) => {
    const prev = value;
    value = { ...value, ...patch };
    for (const cb of watchers) await cb(value, prev);
  },
  replace: async () => {},
};

const ctx = { settings: { register: () => scope } };
const dispose = apply(ctx, {});

// 等宿主匿名出码（grant 模式）
for (let i = 0; i < 15; i++) {
  if (value.mode === "grant" && value.pairingCode && value.grantPairingId) break;
  await sleep(500);
}
console.log("t1 grant code:", JSON.stringify({ mode: value.mode, code: value.pairingCode, pid: value.grantPairingId, err: value.pairError }));
if (!value.grantPairingId || value.pairError) {
  console.error("GRANT CODE FAILED");
  dispose();
  process.exit(1);
}

// 手机侧授权（模拟 App：登录手机账号 → POST grant）
const loginRes = await fetch("https://www.deepseek-claudex.cn/auth/login", {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ username: phoneUser, password: phonePass }),
});
const login = await loginRes.json();
const grantRes = await fetch(`https://www.deepseek-claudex.cn/pairing-codes/${value.grantPairingId}/grant`, {
  method: "POST",
  headers: { "content-type": "application/json", authorization: `Bearer ${login.data.accessToken}` },
  body: "{}",
});
console.log("t2 phone grant:", grantRes.status, JSON.stringify(await grantRes.json()));

// 等插件轮询取走会话：mode 转 pair、桥（enabled=false 时不启动，但会话应落盘）
for (let i = 0; i < 20; i++) {
  if (value.mode === "pair" || existsSync(SESSION_FILE)) break;
  await sleep(500);
}
console.log("t3 after poll:", JSON.stringify({ mode: value.mode, status: value.bridgeStatus, sessionSaved: existsSync(SESSION_FILE) }));
if (existsSync(SESSION_FILE)) {
  const s = JSON.parse(readFileSync(SESSION_FILE, "utf8"));
  console.log("t4 session user:", s.username, "token:", Boolean(s.accessToken));
}

// 开启桥（token 模式应能注册设备并上线）
await scope.update({ enabled: true });
await sleep(5000);
console.log("t5 bridge with token:", JSON.stringify(value.bridgeStatus));

dispose();
if (value.mode === "pair" && existsSync(SESSION_FILE) && value.bridgeStatus === "running") {
  console.log("GRANT SMOKE OK");
  process.exit(0);
}
console.error("GRANT SMOKE FAILED");
process.exit(1);
