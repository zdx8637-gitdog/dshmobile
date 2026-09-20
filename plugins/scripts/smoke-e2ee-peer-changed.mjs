// smoke-e2ee-peer-changed.mjs：验证"PC 端 E2EE 绑定丢失"时不再把手机卡死。
// 背景（用户反馈）：桥丢了 pin 后，手机仍带 pin → hello 回 key-mismatch → App 只提示并保留 pin
//   → 业务请求一直加密 → 一直收 E2EE_RESTARTED → 会话列表永远空，必须手动「取消加密」。
// 本轮修复（注意**故意不改错误码**，否则老版 App 会静默卡住、连提示都没有）：
//   ① 桥丢了 pin 时仍回 key-mismatch，但 error.data 里给 { reason:"no-pin", pinned:false, bridgeKeyId }
//      —— 新版 App 据此自动丢弃过期 pin 并回退明文；老版 App 行为不变（仍提示重新扫码）
//   ② 有 pin 但手机换了身份 → key-mismatch + { reason:"peer-key-changed", pinned:true }
//   ③ 身份文件损坏 → 先备份 .broken-<ts> 再重建 + 告警（不再静默丢 pin）
//   ④ 原子写（写完即可完整解析、无 .tmp 残留）；⑤ 正常配对后 hello 成功（回归）。
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";

const require = createRequire("D:/p/dshmobile-plugin/package.json");
const crypto = require("D:/p/dshmobile-plugin/bridge/crypto.js");
const { E2eeSession } = require("D:/p/dshmobile-plugin/bridge/e2ee.js");
const { Adapter } = require("D:/p/dshmobile-plugin/bridge/adapter.js");

let failures = 0;
const check = (n, c, e = "") => {
  if (c) console.log("  PASS", n);
  else { failures += 1; console.log("  FAIL", n, e); }
};

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "e2ee-smoke-"));
const keyFile = path.join(dir, "device-key.json");
const pairingFile = path.join(dir, "pairing.json");
const DEVICE_ID = "dev-1";

/** 造一个只用来收 respond 的假 relay + 真实 Adapter（私有字段需要真实实例）。 */
function makeAdapter(e2ee) {
  const responses = [];
  const relay = { respond: (requestId, type, payload) => responses.push({ requestId, type, payload }) };
  const dsh = { protocol: "v2", url: "http://127.0.0.1:3080", request: async () => ({ ok: true, value: {} }) };
  const adapter = new Adapter({ dsh, relay, workspaceRoot: dir, e2ee });
  adapter.deviceId = DEVICE_ID;
  return { adapter, responses };
}

const helloEnv = (keyId, requestId = "req-1") => ({
  schemaVersion: 1, envelopeId: "env-1", kind: "request", type: "e2ee.hello", requestId,
  actor: { role: "client", clientId: "c1" }, target: { deviceId: DEVICE_ID },
  payload: { keyId, cNonce: crypto.randomConnectionNonce() },
});

const newPhone = () => crypto.generateIdentityKeypair();

function pair(bridge, phone) {
  const pairingId = "pid-1";
  const secret = crypto.randomPairingSecret();
  fs.writeFileSync(pairingFile, JSON.stringify({ [pairingId]: { secret, expiresAt: Date.now() + 60000 } }));
  const kps = crypto.pairingAuthKey(secret);
  const ctx = crypto.pairingContext({
    pairingId, deviceId: DEVICE_ID,
    bridgePubRaw: crypto.fromB64url(bridge.identity.pubKey),
    phonePubRaw: crypto.fromB64url(phone.pubKey),
    role: "phone",
  });
  const auth = crypto.pairingAuth(kps, ctx);
  return bridge.completePairing({
    pairingId, deviceId: DEVICE_ID, phonePubB64url: phone.pubKey,
    authB64url: Buffer.from(auth).toString("base64url"),
  });
}

console.log("[1] 正常配对后 hello → ok（回归）");
{
  const bridge = new E2eeSession({ stateDir: dir });
  const phone = newPhone();
  check("completePairing ok", pair(bridge, phone).ok === true);
  const { adapter, responses } = makeAdapter(bridge);
  await adapter.handleRequest(helloEnv(phone.keyId));
  check("hello 成功且回本端 keyId/cNonce", responses[0]?.payload?.ok === true && !!responses[0]?.payload?.data?.keyId, JSON.stringify(responses));
}

console.log("[2] 桥丢了 pin（升级/重装/身份文件被清）→ 仍回 key-mismatch，但 data 说明原因（pinned:false）");
{
  fs.rmSync(keyFile, { force: true });                 // 模拟身份/绑定丢失
  const bridge = new E2eeSession({ stateDir: dir });
  const phone = newPhone();                            // 手机仍带着旧 pin（这里用它的 keyId 模拟）
  check("桥状态为 legacy（无 pin）", bridge.isPinned === false, bridge.state);
  const { adapter, responses } = makeAdapter(bridge);
  await adapter.handleRequest(helloEnv(phone.keyId));
  const err = responses[0]?.payload?.error;
  // 码保持不变：老版 App 只认 key-mismatch，换码会让它们静默卡住（这是刻意的兼容约束）
  check("错误码仍是 key-mismatch（不破坏老版 App 的提示行为）", err?.code === "key-mismatch", JSON.stringify(responses));
  check("data.reason = no-pin（新版 App 据此自愈）", err?.data?.reason === "no-pin", JSON.stringify(err));
  check("附带 pinned=false", err?.data?.pinned === false, JSON.stringify(err));
  check("附带 bridgeKeyId（便于诊断）", typeof err?.data?.bridgeKeyId === "string" && err.data.bridgeKeyId.length > 0, JSON.stringify(err?.data));
}

console.log("[3] 桥有 pin 但手机换了身份 → 仍是 key-mismatch（语义不变）");
{
  const bridge = new E2eeSession({ stateDir: dir });
  const phoneA = newPhone();
  pair(bridge, phoneA);
  const phoneB = newPhone();                           // 重装后的新身份
  const { adapter, responses } = makeAdapter(bridge);
  await adapter.handleRequest(helloEnv(phoneB.keyId));
  check("回 key-mismatch", responses[0]?.payload?.error?.code === "key-mismatch", JSON.stringify(responses));
  check("data.reason = peer-key-changed", responses[0]?.payload?.error?.data?.reason === "peer-key-changed", JSON.stringify(responses[0]?.payload?.error));
  check("附带 pinned=true", responses[0]?.payload?.error?.data?.pinned === true, JSON.stringify(responses[0]?.payload?.error));
}

console.log("[4] 身份文件损坏 → 先备份再重建，并给出告警（不再静默丢 pin）");
{
  fs.writeFileSync(keyFile, "");                       // 半截写/空文件
  const bridge = new E2eeSession({ stateDir: dir });
  const baks = fs.readdirSync(dir).filter((f) => f.startsWith("device-key.json.broken-"));
  check("生成了 .broken-<ts> 备份", baks.length === 1, JSON.stringify(fs.readdirSync(dir)));
  check("pinState.loadWarning 有内容", typeof bridge.pinState.loadWarning === "string" && bridge.pinState.loadWarning.length > 0, JSON.stringify(bridge.pinState));
  check("重建后身份可用（pubKey/keyId 非空）", !!bridge.identity.pubKey && !!bridge.identity.keyId, JSON.stringify(bridge.identity.keyId));
}

console.log("[5] 原子写：写完后文件可完整解析，且不留 .tmp 残留");
{
  const bridge = new E2eeSession({ stateDir: dir });
  const phone = newPhone();
  pair(bridge, phone);                                 // 触发 #save
  const raw = fs.readFileSync(keyFile, "utf8");
  let parsed = null;
  try { parsed = JSON.parse(raw); } catch (e) { /* ignore */ }
  check("device-key.json 可完整解析", parsed !== null && !!parsed.pubKey && !!parsed.keyId, raw.slice(0, 60));
  check("含 pinnedPeer（pin 持久化）", !!parsed?.pinnedPeer?.keyId, JSON.stringify(parsed?.pinnedPeer));
  check("无 .tmp 残留", fs.readdirSync(dir).every((f) => !f.includes(".tmp-")), JSON.stringify(fs.readdirSync(dir)));
}

fs.rmSync(dir, { recursive: true, force: true });
console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILURES`);
process.exit(failures === 0 ? 0 : 1);
