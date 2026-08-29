// Phase B 反向传输生产冒烟：模拟 bridge 侧 attachment.resolve 的 relay 半段
// （direction=download 上传 → ready 即终态 → 用户 token 下载校验 sha256）。
// 用法：node scripts/smoke-resolve.mjs
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

const BASE = "https://www.deepseek-claudex.cn";
const cfgPath = join(homedir(), ".dsh-mobile", "config.json");
const cfg = JSON.parse(readFileSync(cfgPath, "utf8"));
const token = cfg.relay.accessToken;
const IMG = readFileSync("D:/p/dshmobile-repo/docs/images/banner.png");
const sha = createHash("sha256").update(IMG).digest("hex");

async function rest(path, options = {}, tk = token) {
  const res = await fetch(BASE + path, {
    ...options,
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${tk}`,
      ...(options.headers ?? {}),
    },
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok || body.ok === false) {
    throw new Error(`${path} failed: HTTP ${res.status} ${JSON.stringify(body.error ?? body)}`);
  }
  return body;
}

const devices = await rest("/devices");
const online = devices.data.filter((d) => d.status === "online");
const deviceId = (online[0] ?? devices.data[0]).id;
console.log("device:", deviceId, online.length ? "(online)" : "");

const ann = await rest("/transfers", {
  method: "POST",
  body: JSON.stringify({
    deviceId, fileId: sha, name: "banner.png", size: IMG.length, sha256: sha,
    targetPath: "attachments/banner", direction: "download",
  }),
});
const transferId = ann.data.transferId;
console.log("announced(download):", transferId);

const up = await fetch(`${BASE}/transfers/${transferId}/chunks`, {
  method: "PUT",
  headers: { "content-type": "application/octet-stream", "x-chunk-offset": "0", authorization: `Bearer ${token}` },
  body: new Uint8Array(IMG),
});
const upBody = await up.json();
if (!up.ok || upBody.ok !== true) throw new Error("chunk failed: " + JSON.stringify(upBody));
console.log("chunk ok:", upBody.data.received, "bytes");

await rest(`/transfers/${transferId}/complete`, { method: "POST", body: "{}" });
const st = await rest(`/transfers/${transferId}`);
console.log("status after complete:", st.data.status, "(期望 ready，不触发 deliver)");
if (st.data.status !== "ready") throw new Error("reverse transfer should stay ready");

const dl = await fetch(`${BASE}/transfers/${transferId}/download`, {
  headers: { authorization: `Bearer ${token}` },
});
const bytes = Buffer.from(await dl.arrayBuffer());
const got = createHash("sha256").update(bytes).digest("hex");
console.log("user-token download:", dl.status, "bytes:", bytes.length);
if (got !== sha) throw new Error("sha256 mismatch");
console.log("SMOKE-RESOLVE OK");
process.exit(0);
