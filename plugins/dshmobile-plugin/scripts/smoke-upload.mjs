// Phase A 端到端冒烟：模拟手机上传 → relay → bridge 落盘（本机真实链路）。
// 用法：node scripts/smoke-upload.mjs
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

const BASE = "https://www.deepseek-claudex.cn";
// 优先用本机桥配置里的会话 token（授权模式账号无密码）；否则走测试账号密码
const cfgPath = join(homedir(), ".dsh-mobile", "config.json");
let token = process.env.TEST_TOKEN ?? "";
if (!token && existsSync(cfgPath)) {
  try { token = JSON.parse(readFileSync(cfgPath, "utf8")).relay?.accessToken ?? ""; } catch {}
}
if (!token) {
  const USER = process.env.TEST_USER ?? "dshtest";
  const PASS = process.env.TEST_PASS ?? "DshTest!2026";
  const login = await rest("/auth/login", { method: "POST", body: JSON.stringify({ username: USER, password: PASS }) });
  token = login.data.accessToken;
  console.log("login ok:", USER);
} else {
  console.log("token: from local bridge config");
}
const CONTENT = Buffer.from(`Phase A e2e smoke #${Date.now()}: hello from the phone side. ` + "x".repeat(3000));
const NAME = "e2e-smoke.txt";
const TARGET = "e2e/" + NAME;

const sha = createHash("sha256").update(CONTENT).digest("hex");

async function rest(path, options = {}, token) {
  const res = await fetch(BASE + path, {
    ...options,
    headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}), ...(options.headers ?? {}) },
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok || body.ok === false) {
    throw new Error(`${path} failed: HTTP ${res.status} ${JSON.stringify(body.error ?? body)}`);
  }
  return body;
}

const devices = await rest("/devices", {}, token);
const online = devices.data?.filter((d) => d.status === "online");
const deviceId = (online?.length ? online : devices.data)?.[0]?.id;
if (!deviceId) throw new Error("no devices for account");
console.log("device:", deviceId, online?.length ? "(online)" : "(no online device — first device)");

const ann = await rest("/transfers", {
  method: "POST",
  body: JSON.stringify({ deviceId, fileId: sha, name: NAME, size: CONTENT.length, sha256: sha, targetPath: TARGET }),
}, token);
const transferId = ann.data.transferId;
console.log("announced:", transferId, "received:", ann.data.received);

const up = await fetch(`${BASE}/transfers/${transferId}/chunks`, {
  method: "PUT",
  headers: { "content-type": "application/octet-stream", "x-chunk-offset": "0", authorization: `Bearer ${token}` },
  body: new Uint8Array(CONTENT),
});
const upBody = await up.json();
if (!up.ok || upBody.ok !== true) throw new Error("chunk failed: " + JSON.stringify(upBody));
console.log("chunk ok, received:", upBody.data.received);

const comp = await rest(`/transfers/${transferId}/complete`, { method: "POST", body: "{}" }, token);
console.log("complete → status:", comp.data.status);

// 等待 bridge 投递 + 落盘（relay 投递是异步的）
const local = join(homedir(), ".dsh-mobile", "deliveries", TARGET);
let landed = false;
for (let i = 0; i < 30; i++) {
  if (existsSync(local)) {
    const bytes = readFileSync(local);
    if (bytes.length === CONTENT.length && createHash("sha256").update(bytes).digest("hex") === sha) {
      landed = true;
      break;
    }
  }
  await new Promise((r) => setTimeout(r, 1000));
}
if (!landed) {
  const st = await rest(`/transfers/${transferId}`, {}, token);
  console.error("NOT LANDED. transfer status:", JSON.stringify(st.data));
  process.exit(1);
}
console.log("LANDED:", local, "sha256 一致 ✓");
console.log("SMOKE-UPLOAD OK");
process.exit(0);
