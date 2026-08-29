// 诊断：模拟手机的完整上传链路（WS 控制面 + REST 数据面），验证 upload.commit 是否真的把消息送进会话。
// 用法：node scripts/diag-upload-commit.mjs
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { WebSocket } from "ws";

const BASE = "https://www.deepseek-claudex.cn";
const WS = "wss://www.deepseek-claudex.cn/ws/client";
const cfg = JSON.parse(readFileSync(join(homedir(), ".dsh-mobile", "config.json"), "utf8"));
const token = cfg.relay.accessToken;
const devices = await (await fetch(`${BASE}/devices`, { headers: { authorization: `Bearer ${token}` } })).json();
const device = (devices.data.find((d) => d.status === "online") ?? devices.data[0]);
console.log("device:", device.id);

function wsRequest(ws, type, payload, timeoutMs = 45000) {
  const requestId = "diag-" + Math.random().toString(36).slice(2, 10);
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${type} timeout`)), timeoutMs);
    const handler = (raw) => {
      const env = JSON.parse(raw.toString());
      if (env.requestId === requestId) {
        clearTimeout(timer);
        ws.off("message", handler);
        resolve(env);
      }
    };
    ws.on("message", handler);
    ws.send(JSON.stringify({
      schemaVersion: 1, kind: "request", type, requestId,
      sentAt: new Date().toISOString(),
      actor: { role: "client", clientId: "diag-client" },
      target: { deviceId: device.id },
      payload,
    }));
  });
}

const ws = new WebSocket(WS, ["bearer", token]);
await new Promise((r, j) => { ws.on("open", r); ws.on("error", j); });
// 等 device.status 帧
const first = await new Promise((r) => { const h = (raw) => { const e = JSON.parse(raw.toString()); if (e.type === "device.status") { ws.off("message", h); r(e); } }; ws.on("message", h); });
console.log("ws connected, bridge online:", first.payload?.online);

const list = await wsRequest(ws, "sessions.list", {});
const sessions = list.payload?.data?.sessions ?? [];
console.log("sessions:", sessions.length);
const sid = sessions[0]?.sessionId;
if (!sid) { console.error("无会话"); process.exit(1); }
console.log("using session:", sid);

const CONTENT = Buffer.from(`diag upload ${Date.now()} hello`);
const sha = createHash("sha256").update(CONTENT).digest("hex");
const ann = await (await fetch(`${BASE}/transfers`, {
  method: "POST",
  headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
  body: JSON.stringify({ deviceId: device.id, fileId: sha, name: "diag.txt", size: CONTENT.length, sha256: sha, targetPath: "uploads/diag.txt" }),
})).json();
const transferId = ann.data.transferId;
console.log("announced:", transferId);
await fetch(`${BASE}/transfers/${transferId}/chunks`, {
  method: "PUT",
  headers: { "content-type": "application/octet-stream", "x-chunk-offset": "0", authorization: `Bearer ${token}` },
  body: new Uint8Array(CONTENT),
});
await fetch(`${BASE}/transfers/${transferId}/complete`, {
  method: "POST", headers: { authorization: `Bearer ${token}` }, body: "{}",
});
console.log("uploaded + completed, waiting 3s for bridge deliver...");
await new Promise((r) => setTimeout(r, 3000));

const commit = await wsRequest(ws, "upload.commit", {
  transferId, fileId: sha, name: "diag.txt", size: CONTENT.length, sha256: sha,
  targetPath: "uploads/diag.txt", sessionId: sid,
});
console.log("upload.commit response:", JSON.stringify(commit.payload).slice(0, 400));
ws.close();
process.exit(commit.payload?.ok === true ? 0 : 1);
