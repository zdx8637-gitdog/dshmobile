// 扫码登录（方向一）出码：以 bridge 配置的账号登录 relay 并生成一次性配对码。
// 用法：node bridge/src/pair.mjs
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const config = JSON.parse(readFileSync(join(HERE, "..", "config.json"), "utf8"));

const relay = config.relay.url.replace(/\/$/, "");

const loginRes = await fetch(`${relay}/auth/login`, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ username: config.relay.username, password: config.relay.password }),
});
const login = await loginRes.json();
if (!loginRes.ok || login.ok === false) {
  console.error("登录失败:", JSON.stringify(login.error ?? login));
  process.exit(1);
}

const createRes = await fetch(`${relay}/pairing-codes`, {
  method: "POST",
  headers: {
    "content-type": "application/json",
    authorization: `Bearer ${login.data.accessToken}`,
  },
  body: "{}",
});
const created = await createRes.json();
if (!createRes.ok || created.ok === false) {
  console.error("出码失败:", JSON.stringify(created.error ?? created));
  process.exit(1);
}

const { code, expiresAt } = created.data;
const deepLink = `dshmobile://pair?relay=${encodeURIComponent(relay)}&code=${code}`;

console.log("=== 手机扫码登录 ===");
console.log("配对码:", code);
console.log("有效期至:", expiresAt);
console.log("扫码链接:", deepLink);
