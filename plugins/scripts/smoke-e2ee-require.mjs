// smoke-e2ee-require.mjs：E2EE「默认强制 + 用户显式降级」桥侧定向回归（产品方案 D 的桥侧部分）。
// 链路与 main.js 完全一致：真 RelayBridge（真 E2eeSession，stateDir = 临时目录）+ 真 Adapter + 伪造 dsh，
// 每条信封都走 relay.decryptEnvelope → adapter.handleRequest → respond/forwardEvent，桥 → relay 方向的
// 全部信封落在 sent（等价于手机侧观察到的东西）。不连中继、不连 DSH。
//
// 缺陷背景：PC 已配对（device-key.json 有 pinnedPeer）时，一台没有本地 pin 的手机（重装 App 后）发来的
// 明文请求会被静默放行（只有 established===true 才回 E2EE_REQUIRED，桥一重启就再也不提示），
// 用户既不知道自己在明文、也看不到配对提示。
// 覆盖（编号对应任务清单）：
//   ① 未上报 appVersion 的老 App 明文 → 放行（fail-open，不被卡死）
//   ② 上报 appVersion=0.2.21 → E2EE_REQUIRED + error.data{reason,require,pinned,bridgeKeyId}
//   ③ e2ee.allowPlaintext mode=session → 只对该 clientId 临时放行，不动 pin/policy，桥重启即失效
//   ④ e2ee.allowPlaintext mode=permanent → 清 pin + e2ee-policy.json 落盘 require=false，之后明文放行
//   ⑤ e2ee.state → {require,pinned,bridgeKeyId} 且与实际一致
//   ⑥ 配对成功 → policy 回到 require=true（覆盖"用户曾选永久非加密"）+ 推 host/e2ee-state 帧
//   ⑦ sessions.list 响应 data 增加 e2ee 字段（只增字段）
//   ⑧ 控制类类型（e2ee.hello/key.exchange/e2ee.clear/heartbeat.ping/device.register/e2ee.state/
//      e2ee.allowPlaintext/transfer.deliver）永远不被 E2EE 拒绝
//   ⑨ supportsRequireE2ee 版本闸门边界
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Adapter } from "../bridge/adapter.js";
import { RelayBridge } from "../bridge/relay.js";
import { E2eeSession } from "../bridge/e2ee.js";
import { supportsRequireE2ee } from "../bridge/e2ee-policy.js";
import * as crypto from "../bridge/crypto.js";

let failures = 0;
function ok(name, cond, extra = "") {
  if (cond) console.log(`  PASS ${name}`);
  else { failures += 1; console.log(`  FAIL ${name} ${extra}`); }
}

const stateDir = mkdtempSync(join(tmpdir(), "e2ee-require-"));
const DEVICE_ID = "dev-1";
const POLICY_FILE = join(stateDir, "e2ee-policy.json");
const sent = [];      // 桥 → relay 的全部信封（响应 + 事件帧）
const dshCalls = [];  // 落到 DSH 的调用（用来证明"被拒的请求根本没进 adapter/dsh"）

const fakeDsh = {
  protocol: "v2",
  url: "http://127.0.0.1:3080",
  async unary(method) {
    dshCalls.push(method);
    if (method === "session/list") {
      return {
        ok: true,
        value: {
          items: [{
            sessionId: "sess-1", updatedAt: Date.now(), running: false, blank: false,
            cwd: stateDir, projections: { values: { title: "测试会话" } },
          }],
        },
      };
    }
    return { ok: false, error: { code: "UNSUPPORTED", message: method } };
  },
};

/** 造一条与 main.js 等价的桥：真 RelayBridge（假 ws）+ 真 Adapter（relay/adapter 自行接线）。 */
function buildPipeline() {
  const e2ee = new E2eeSession({ stateDir });
  const relay = new RelayBridge({
    url: "https://relay.invalid",
    username: "", password: "",
    deviceLabel: "smoke", platform: "windows", clientDeviceKey: "k",
    stateDir, accessToken: "", refreshToken: "", e2ee,
  });
  relay.deviceId = DEVICE_ID;
  relay.ws = { readyState: 1, send: (s) => sent.push(JSON.parse(s)) };
  const adapter = new Adapter({ dsh: fakeDsh, relay, workspaceRoot: stateDir, e2ee });
  // workspace 基线就绪（否则 sessions.list 要等 15s 超时）
  adapter.handleWorkspaceFrame({ type: "baseline", value: { items: [], archivedSessionIds: [] } });
  return { e2ee, relay, adapter };
}

const pipe = buildPipeline();

let envSeq = 0;
function env(type, payload = {}, { requestId, clientId = "c1", appVersion } = {}) {
  envSeq += 1;
  return {
    schemaVersion: 1,
    envelopeId: `env-${envSeq}`,
    kind: "request",
    type,
    requestId: requestId ?? `r-${envSeq}`,
    sentAt: new Date().toISOString(),
    actor: { role: "client", clientId },
    target: { deviceId: DEVICE_ID },
    ...(typeof appVersion === "string" ? { appVersion } : {}),
    payload,
  };
}

/** 与 main.js 的 relay.onEnvelope 同路径：解密 →（放行的才）交给 adapter。 */
async function deliver(p, e) {
  const plain = p.relay.decryptEnvelope(e);
  if (plain?.kind === "request" && typeof plain.requestId === "string") {
    await p.adapter.handleRequest(plain);
  }
  return plain;
}

const lastResponse = (requestId) => sent.filter((x) => x.kind === "response" && x.requestId === requestId).at(-1);
const payloadOf = (requestId) => lastResponse(requestId)?.payload;
const e2eeFrames = () => sent.filter((x) => x.kind === "event" && x.payload?.frame?.type === "host/e2ee-state").map((x) => x.payload.frame);
const rejectedIds = () => sent.filter((x) => x.payload?.error?.code === "E2EE_REQUIRED").map((x) => x.requestId);
const policyOnDisk = () => (existsSync(POLICY_FILE) ? JSON.parse(readFileSync(POLICY_FILE, "utf8")) : null);
const listCallCount = () => dshCalls.filter((m) => m === "session/list").length;
const sessionsOf = (requestId) => payloadOf(requestId)?.data?.sessions;

/** 走真实 key.exchange（真 crypto：写 pairing.json secret + 用 phone 身份算 auth）。 */
async function pairOnce(p, pairingId, requestId, clientId) {
  const phone = crypto.generateIdentityKeypair();
  const secret = crypto.randomPairingSecret();
  writeFileSync(join(stateDir, "pairing.json"), JSON.stringify({ [pairingId]: { secret, expiresAt: Date.now() + 60000 } }));
  const ctx = crypto.pairingContext({
    pairingId, deviceId: DEVICE_ID,
    bridgePubRaw: crypto.fromB64url(p.e2ee.identity.pubKey),
    phonePubRaw: crypto.fromB64url(phone.pubKey),
    role: "phone",
  });
  const auth = crypto.toB64url(crypto.pairingAuth(crypto.pairingAuthKey(secret), ctx));
  await deliver(p, env("key.exchange", { pairingId, deviceId: DEVICE_ID, pub: phone.pubKey, auth }, { requestId, clientId, appVersion: "0.2.21" }));
  return phone;
}

console.log("[0] 前提：默认策略（无 e2ee-policy.json → require=true）");
ok("无策略文件时 e2ee.require === true", pipe.e2ee.require === true && !existsSync(POLICY_FILE), `require=${pipe.e2ee.require} exists=${existsSync(POLICY_FILE)}`);
ok("初始未配对（pinned=false）", pipe.e2ee.isPinned === false);

console.log("[①] 未上报 appVersion 的老 App：明文 sessions.list 放行（fail-open，不被卡死）");
await deliver(pipe, env("sessions.list", {}, { requestId: "r-legacy", clientId: "legacy-app" }));
ok("放行且真的执行了 sessions.list", payloadOf("r-legacy")?.ok === true && Array.isArray(sessionsOf("r-legacy")) && sessionsOf("r-legacy").length === 1, JSON.stringify(payloadOf("r-legacy"))?.slice(0, 200));
ok("进入了 DSH（session/list 调用 +1）", listCallCount() === 1, `calls=${listCallCount()}`);
ok("没有任何 E2EE_REQUIRED", rejectedIds().length === 0, JSON.stringify(rejectedIds()));

console.log("[②] 上报 appVersion=0.2.21：明文业务请求 → E2EE_REQUIRED + error.data");
const listBefore2 = listCallCount();
const plain2 = await deliver(pipe, env("sessions.list", {}, { requestId: "r-new", clientId: "app-new", appVersion: "0.2.21" }));
const res2 = lastResponse("r-new");
ok("decryptEnvelope 返回 null（不透传给 adapter）", plain2 === null, JSON.stringify(plain2)?.slice(0, 120));
ok("回 E2EE_REQUIRED + control 标记", res2?.payload?.ok === false && res2.payload.error?.code === "E2EE_REQUIRED" && res2.payload.control === true, JSON.stringify(res2?.payload)?.slice(0, 200));
ok("error.data.reason === \"require-e2ee\"", res2?.payload?.error?.data?.reason === "require-e2ee", JSON.stringify(res2?.payload?.error));
ok("error.data.require === true", res2?.payload?.error?.data?.require === true);
ok("error.data.pinned === false（本机尚未配对）", res2?.payload?.error?.data?.pinned === false);
ok("error.data.bridgeKeyId 非空且与 e2ee.pinState 一致", typeof res2?.payload?.error?.data?.bridgeKeyId === "string" && res2.payload.error.data.bridgeKeyId.length > 0 && res2.payload.error.data.bridgeKeyId === pipe.e2ee.pinState.bridgeKeyId, JSON.stringify(res2?.payload?.error?.data));
ok("被拒的请求没有进 adapter/DSH", listCallCount() === listBefore2, `calls=${listCallCount()}`);
ok("响应保持原 type/requestId（App 能对上号）", res2?.type === "sessions.list" && res2?.requestId === "r-new" && res2?.kind === "response");

console.log("[⑥-a] 先建立配对（为后面「永久降级会清 pin」提供前提；同时验证配对成功推帧）");
await pairOnce(pipe, "pair-1", "k1", "app-new");
ok("key.exchange ok", payloadOf("k1")?.ok === true, JSON.stringify(payloadOf("k1")));
ok("pin 建立", pipe.e2ee.isPinned === true);
ok("配对后 policy 仍为 require=true", pipe.e2ee.require === true);
ok("推了 host/e2ee-state 帧（require=true / pinned=true）", e2eeFrames().some((f) => f.require === true && f.pinned === true), JSON.stringify(e2eeFrames()));
ok("帧内 bridgeKeyId 与 pinState 一致", e2eeFrames().some((f) => f.bridgeKeyId === pipe.e2ee.pinState.bridgeKeyId));
ok("帧形状只含 type/require/pinned/bridgeKeyId", e2eeFrames().every((f) => JSON.stringify(Object.keys(f).sort()) === JSON.stringify(["bridgeKeyId", "pinned", "require", "type"])), JSON.stringify(e2eeFrames()));

console.log("[②-b] 已配对（pinned=true）后，0.2.21 客户端明文仍被拒，data.pinned=true");
await deliver(pipe, env("sessions.list", {}, { requestId: "r-new-pinned", clientId: "app-new", appVersion: "0.2.21" }));
ok("仍回 E2EE_REQUIRED", payloadOf("r-new-pinned")?.error?.code === "E2EE_REQUIRED", JSON.stringify(payloadOf("r-new-pinned"))?.slice(0, 160));
ok("data.pinned === true（App 据此区分「重新配对」与「直接降级」）", payloadOf("r-new-pinned")?.error?.data?.pinned === true);

console.log("[③] e2ee.allowPlaintext mode=session：只临时放行该 clientId，不动 pin/policy");
await deliver(pipe, env("e2ee.allowPlaintext", { deviceId: DEVICE_ID, mode: "bogus" }, { requestId: "a-bad", clientId: "app-new", appVersion: "0.2.21" }));
ok("非法 mode → bad-request", payloadOf("a-bad")?.error?.code === "bad-request", JSON.stringify(payloadOf("a-bad")));
ok("非法 mode 不改任何状态", pipe.e2ee.require === true && pipe.e2ee.isPinned === true);
await deliver(pipe, env("e2ee.allowPlaintext", { deviceId: DEVICE_ID, mode: "session" }, { requestId: "a-session", clientId: "app-new", appVersion: "0.2.21" }));
ok("回 ok + mode=session", payloadOf("a-session")?.ok === true && payloadOf("a-session")?.data?.mode === "session", JSON.stringify(payloadOf("a-session")));
ok("data 里 require=true / pinned=true（session 模式什么都没改）", payloadOf("a-session")?.data?.require === true && payloadOf("a-session")?.data?.pinned === true);
ok("pin 未被清除", pipe.e2ee.isPinned === true && pipe.e2ee.pinState.pinned === true);
ok("policy 未被改动（内存 true；磁盘 true 或仍无文件）", pipe.e2ee.require === true && (policyOnDisk() === null || policyOnDisk().require === true), JSON.stringify(policyOnDisk()));
await deliver(pipe, env("sessions.list", {}, { requestId: "r-session-ok", clientId: "app-new", appVersion: "0.2.21" }));
ok("之后明文 sessions.list 放行", payloadOf("r-session-ok")?.ok === true && Array.isArray(sessionsOf("r-session-ok")), JSON.stringify(payloadOf("r-session-ok"))?.slice(0, 160));
await deliver(pipe, env("sessions.list", {}, { requestId: "r-other-client", clientId: "app-new-2", appVersion: "0.2.21" }));
ok("临时放行只对该 clientId 生效（另一个 0.2.21 客户端仍被拒）", payloadOf("r-other-client")?.error?.code === "E2EE_REQUIRED", JSON.stringify(payloadOf("r-other-client"))?.slice(0, 160));

console.log("[③-b] 临时放行只在内存：新桥实例（= 桥重启）后同一 clientId 又被拒");
const pipe2 = buildPipeline();
await deliver(pipe2, env("sessions.list", {}, { requestId: "r-after-restart", clientId: "app-new", appVersion: "0.2.21" }));
ok("重启后同一 clientId 的明文被拒（session 放行不落盘）", payloadOf("r-after-restart")?.error?.code === "E2EE_REQUIRED", JSON.stringify(payloadOf("r-after-restart"))?.slice(0, 160));
ok("重启后策略仍是 require=true（没把临时放行写进策略）", pipe2.e2ee.require === true && (policyOnDisk() === null || policyOnDisk().require === true), JSON.stringify(policyOnDisk()));

console.log("[④] e2ee.allowPlaintext mode=permanent：清 pin + e2ee-policy.json require=false 落盘");
const framesBefore4 = e2eeFrames().length;
await deliver(pipe, env("e2ee.allowPlaintext", { deviceId: DEVICE_ID, mode: "permanent" }, { requestId: "a-perm", clientId: "app-new", appVersion: "0.2.21" }));
const ap4 = payloadOf("a-perm");
ok("回 ok + mode=permanent + require=false / pinned=false", ap4?.ok === true && ap4?.data?.mode === "permanent" && ap4?.data?.require === false && ap4?.data?.pinned === false, JSON.stringify(ap4));
ok("pin 被清", pipe.e2ee.isPinned === false && pipe.e2ee.pinState.pinned === false);
ok("e2ee-policy.json 落盘 require=false", policyOnDisk()?.require === false, JSON.stringify(policyOnDisk()));
ok("内存策略同步为 false", pipe.e2ee.require === false);
ok("推了 require=false / pinned=false 的 host/e2ee-state 帧", e2eeFrames().length > framesBefore4 && e2eeFrames().some((f) => f.require === false && f.pinned === false));
ok("原子写：目录里没有 .tmp 残留", readdirSync(stateDir).every((f) => !f.includes(".tmp-")), JSON.stringify(readdirSync(stateDir)));
await deliver(pipe, env("sessions.list", {}, { requestId: "r-perm-ok", clientId: "app-new", appVersion: "0.2.21" }));
ok("永久降级后：已上报版本的客户端明文也放行", payloadOf("r-perm-ok")?.ok === true && Array.isArray(sessionsOf("r-perm-ok")), JSON.stringify(payloadOf("r-perm-ok"))?.slice(0, 160));

console.log("[⑥-b] 再次配对成功 → policy 回到 require=true（覆盖「用户曾选永久非加密」）");
await pairOnce(pipe, "pair-2", "k2", "app-new");
ok("key.exchange ok", payloadOf("k2")?.ok === true, JSON.stringify(payloadOf("k2")));
ok("pin 重新建立", pipe.e2ee.isPinned === true);
ok("policy 回到 require=true（内存 + 磁盘）", pipe.e2ee.require === true && policyOnDisk()?.require === true, `mem=${pipe.e2ee.require} disk=${JSON.stringify(policyOnDisk())}`);
ok("推了 require=true / pinned=true 的 host/e2ee-state 帧", e2eeFrames().some((f) => f.require === true && f.pinned === true));
await deliver(pipe, env("sessions.list", {}, { requestId: "r-after-pair", clientId: "app-new", appVersion: "0.2.21" }));
ok("配对后明文又被拒（默认强制回来了）", payloadOf("r-after-pair")?.error?.code === "E2EE_REQUIRED", JSON.stringify(payloadOf("r-after-pair"))?.slice(0, 160));
ok("配对成功同时撤销该 clientId 的临时明文放行（配完对不再静默走明文）", !pipe.adapter.plaintextSessionAllowed.has("app-new") && payloadOf("r-after-pair")?.error?.code === "E2EE_REQUIRED");

console.log("[⑤] e2ee.state：明文永远可用，回 {require,pinned,bridgeKeyId} 且与实际一致");
await deliver(pipe, env("e2ee.state", { deviceId: DEVICE_ID }, { requestId: "s-state", clientId: "app-new", appVersion: "0.2.21" }));
const st5 = payloadOf("s-state");
ok("ok:true 且只回三个字段", st5?.ok === true && JSON.stringify(Object.keys(st5?.data ?? {}).sort()) === JSON.stringify(["bridgeKeyId", "pinned", "require"]), JSON.stringify(st5));
ok("require/pinned/bridgeKeyId 与 e2ee 实际一致", st5?.data?.require === pipe.e2ee.require && st5?.data?.pinned === pipe.e2ee.isPinned && st5?.data?.bridgeKeyId === pipe.e2ee.pinState.bridgeKeyId, `${JSON.stringify(st5?.data)} vs ${JSON.stringify(pipe.e2ee.pinState)}`);
ok("当前取值 require=true / pinned=true", st5?.data?.require === true && st5?.data?.pinned === true);
await deliver(pipe, env("e2ee.state", {}, { requestId: "s-state-legacy", clientId: "legacy-app" }));
ok("老 App（无 appVersion）也能拿到 e2ee.state", payloadOf("s-state-legacy")?.ok === true && payloadOf("s-state-legacy")?.data?.require === true);

console.log("[⑦] sessions.list 响应 data 带 e2ee 字段（只增字段）");
await deliver(pipe, env("sessions.list", {}, { requestId: "r-list-e2ee", clientId: "legacy-app" }));
const d7 = payloadOf("r-list-e2ee")?.data;
ok("ok + 既有字段仍在（sessions/archivedSessionIds/completedSessionIds/pendingSessionIds/servedAt）", payloadOf("r-list-e2ee")?.ok === true && Array.isArray(d7?.sessions) && Array.isArray(d7?.archivedSessionIds) && Array.isArray(d7?.completedSessionIds) && Array.isArray(d7?.pendingSessionIds) && typeof d7?.servedAt === "number", JSON.stringify(Object.keys(d7 ?? {})));
ok("data.e2ee = {require:true,pinned:true,bridgeKeyId}", JSON.stringify(d7?.e2ee) === JSON.stringify({ require: true, pinned: true, bridgeKeyId: pipe.e2ee.pinState.bridgeKeyId }), JSON.stringify(d7?.e2ee));
ok("与 e2ee.state 的口径一致", JSON.stringify(d7?.e2ee) === JSON.stringify(st5?.data), `${JSON.stringify(d7?.e2ee)} vs ${JSON.stringify(st5?.data)}`);

console.log("[⑧] 控制类类型永远不被拒（客户端上报 0.2.21、策略 require=true）");
const controlCases = [
  ["e2ee.hello", { keyId: "deadbeefdeadbeef", cNonce: "AAAA" }],
  ["heartbeat.ping", { now: new Date().toISOString() }],
  ["device.register", {}],
  ["e2ee.state", {}],
  ["e2ee.allowPlaintext", { mode: "bogus" }],
  ["key.exchange", {}],
  ["transfer.deliver", { transferId: "t1" }],
  ["e2ee.clear", {}],
];
for (const [type, payload] of controlCases) {
  const rid = `ctl-${type}`;
  const plain = await deliver(pipe, env(type, payload, { requestId: rid, clientId: "app-new", appVersion: "0.2.21" }));
  ok(`⑧ ${type} 未被 E2EE 拒绝（原样进 adapter）`, plain !== null && payloadOf(rid)?.error?.code !== "E2EE_REQUIRED", JSON.stringify(payloadOf(rid))?.slice(0, 160));
}
ok("⑧ 全程没有任何一条控制类请求被 E2EE_REQUIRED 拒", rejectedIds().every((id) => !id.startsWith("ctl-")), JSON.stringify(rejectedIds()));
ok("⑧ e2ee.clear 仍是「清 pin + 永久非加密」（语义与 permanent 一致）", pipe.e2ee.isPinned === false && pipe.e2ee.require === false && policyOnDisk()?.require === false, `pinned=${pipe.e2ee.isPinned} require=${pipe.e2ee.require} disk=${JSON.stringify(policyOnDisk())}`);
ok("⑧ e2ee.clear 回包不变（{ok:true,data:{cleared:true}}）", JSON.stringify(payloadOf("ctl-e2ee.clear")) === JSON.stringify({ ok: true, data: { cleared: true } }), JSON.stringify(payloadOf("ctl-e2ee.clear")));
ok("⑧ e2ee.clear 后推了 require=false / pinned=false 帧", e2eeFrames().some((f) => f.require === false && f.pinned === false));
ok("⑧ 去重生效：同一状态不重复推帧", (() => {
  const before = e2eeFrames().length;
  pipe.adapter.handleWorkspaceFrame({ type: "baseline", value: { items: [], archivedSessionIds: [] } }); // 无关状态变化
  return e2eeFrames().length === before;
})());

console.log("[⑨] supportsRequireE2ee 版本闸门边界");
const versionCases = [
  [undefined, false], [null, false], ["", false], ["abc", false], [0.221, false],
  ["0.2.20", false], ["0.2.21", true], ["0.3.0", true], ["1.0.0", true], ["1.0", true],
  ["0.2.21-beta.1", true], ["0.2.20-rc.1", false], ["0.2", false], ["0.2.21.1", true],
];
for (const [v, want] of versionCases) {
  ok(`⑨ supportsRequireE2ee(${JSON.stringify(v)}) === ${want}`, supportsRequireE2ee(v) === want, `got=${supportsRequireE2ee(v)}`);
}

rmSync(stateDir, { recursive: true, force: true });
console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILURES`);
process.exit(failures === 0 ? 0 : 1);
