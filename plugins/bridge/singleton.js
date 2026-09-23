// 桥的单实例保护（根治"同一设备两条桥连接互相顶替"）：
//   1) 按 stateDir 派生一个**本机回环端口**作为单例锁——操作系统保证同一时刻只有一个进程能绑定，
//      进程死亡即自动释放，因此不会像 pid 文件那样出现"僵尸锁/PID 复用"问题；
//   2) 新实例发现端口被占时会向占用者发 `{"cmd":"yield"}`「让位请求」，让占用者优雅退出，
//      从而保证**最新启动的实例（通常也是最新代码）拿到锁**；
//   3) 让位不成功则本进程以退出码 42 退出（宿主据此不自动重启，避免两个宿主互相重启）。
//
// 为什么需要它：`~/.dsh-mobile` 是用户级共享目录，多个 DSH 实例/孤儿桥进程会共用同一份
// config.json 与 clientDeviceKey ⇒ 同一个 relay deviceId ⇒ 在 relay 侧互相把对方踢下线，
// 形成永动互踢（详见 WORKFLOW.md §7.0）。
import { createServer, connect } from "node:net";
import { writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";

/** 另一个桥实例仍占着单例（未让位）→ 本进程退出，宿主不得自动重启。 */
export const EXIT_ANOTHER_INSTANCE = 42;
/** 本进程已让位给更新的实例 → 宿主不得自动重启。 */
export const EXIT_YIELDED = 43;

/**
 * 单例端口：stateDir 稳定散列到 17660..17699。
 * 用不同 stateDir（临时第二桥、测试）会得到不同端口，互不干扰。
 */
export function singletonPort(stateDir) {
  const key = String(stateDir ?? "").toLowerCase();
  let h = 2166136261; // FNV-1a
  for (let i = 0; i < key.length; i++) {
    h ^= key.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return 17660 + ((h >>> 0) % 40);
}

/** 单例保护是否启用（`DSHMOBILE_BRIDGE_SINGLETON=0` 可关闭，用于临时第二桥/测试）。 */
export function isSingletonEnabled() {
  const v = String(process.env.DSHMOBILE_BRIDGE_SINGLETON ?? "").trim().toLowerCase();
  return !(v === "0" || v === "false" || v === "off" || v === "no");
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 尝试绑定回环端口；已被占用时返回 {ok:false}。 */
function tryBind(port) {
  return new Promise((resolve) => {
    const server = createServer();
    const onError = (err) => {
      server.removeListener("listening", onListening);
      try { server.close(); } catch { /* 未监听 */ }
      resolve({ ok: false, code: err?.code ?? "ERROR", message: err?.message ?? String(err) });
    };
    const onListening = () => {
      server.removeListener("error", onError);
      resolve({ ok: true, server });
    };
    server.once("error", onError);
    server.once("listening", onListening);
    server.listen({ port, host: "127.0.0.1", exclusive: true });
  });
}

/** 给占用者发让位请求（对方收到后应优雅退出并释放端口）。 */
function askYield(port, log) {
  return new Promise((resolve) => {
    let done = false;
    const finish = (v) => { if (!done) { done = true; try { sock.destroy(); } catch { /* 已关 */ } resolve(v); } };
    const sock = connect({ port, host: "127.0.0.1" });
    const timer = setTimeout(() => finish(false), 1200);
    sock.on("connect", () => sock.write(JSON.stringify({ cmd: "yield", pid: process.pid }) + "\n"));
    sock.on("data", (buf) => {
      clearTimeout(timer);
      const text = String(buf).trim();
      log?.(`[singleton] 占用者回应：${text.slice(0, 120) || "(空)"}`);
      finish(true);
    });
    sock.on("error", (err) => { clearTimeout(timer); finish(false); void err; });
    sock.on("close", () => { clearTimeout(timer); finish(false); });
  });
}

/** 占用者侧：监听让位请求，收到后回调 onYield（调用方负责优雅退出）。 */
export function attachYieldHandler(server, onYield, log = console.log) {
  server.on("connection", (sock) => {
    let buf = "";
    sock.on("data", (chunk) => {
      buf += String(chunk);
      const line = buf.split("\n")[0];
      if (!line) return;
      let msg = null;
      try { msg = JSON.parse(line); } catch { /* 非协议数据，忽略 */ }
      if (msg?.cmd === "yield") {
        try { sock.write(JSON.stringify({ ok: true, pid: process.pid, msg: "yielding" }) + "\n"); } catch { /* 对端已走 */ }
        log(`[singleton] 收到让位请求（来自 pid=${msg.pid ?? "?"}），本进程退出让位`);
        onYield?.();
      }
    });
    sock.on("error", () => { /* 对端断开 */ });
  });
}

/**
 * 抢占单例。
 * @param askYield 是否允许"请求对方让位"（默认 true）。宿主在**延迟重试**时传 false：
 *   只要对方还活着就安静退出，绝不反过来要求对方让位，从而不会形成两个宿主互相顶替。
 * @returns {Promise<{ok:true,server:import('node:net').Server,port:number,tookOver:boolean}
 *                  |{ok:false,port:number,reason:string}>}
 */
export async function claimSingleton({ stateDir, log = console.log, onYield = null, askYield: mayAskYield = true, waitMs = 3000, retryMs = 150 } = {}) {
  const port = singletonPort(stateDir);
  const first = await tryBind(port);
  if (first.ok) {
    attachYieldHandler(first.server, onYield, log);
    return { ok: true, server: first.server, port, tookOver: false };
  }
  if (!mayAskYield) {
    log(`[singleton] 回环端口 ${port} 已被占用（${first.code}）：本次为礼貌重试，不请求对方让位`);
    const shortDeadline = Date.now() + 1200;
    while (Date.now() < shortDeadline) {
      await sleep(retryMs);
      const again = await tryBind(port);
      if (again.ok) {
        attachYieldHandler(again.server, onYield, log);
        return { ok: true, server: again.server, port, tookOver: true };
      }
    }
    return { ok: false, port, reason: "另一个桥实例仍占用单例端口（礼貌重试未接管）" };
  }
  log(`[singleton] 回环端口 ${port} 已被另一个桥实例占用（${first.code}），发送让位请求…`);
  await askYield(port, log);
  const deadline = Date.now() + waitMs;
  while (Date.now() < deadline) {
    await sleep(retryMs);
    const again = await tryBind(port);
    if (again.ok) {
      attachYieldHandler(again.server, onYield, log);
      return { ok: true, server: again.server, port, tookOver: true };
    }
  }
  return { ok: false, port, reason: "另一个桥实例仍占用单例端口（未让位）" };
}

/** 诊断用：把"谁持有单例"落盘，便于面板/人工排查（不参与加锁语义）。 */
export function writeSingletonInfo(stateDir, { port, tookOver }) {
  try {
    writeFileSync(
      join(stateDir, "bridge.lock.json"),
      JSON.stringify({ pid: process.pid, port, tookOver: Boolean(tookOver), startedAt: new Date().toISOString(), stateDir }, null, 2),
    );
  } catch { /* 诊断文件失败不影响运行 */ }
}

/** 退出时清理诊断文件（best effort）。 */
export function clearSingletonInfo(stateDir) {
  try { rmSync(join(stateDir, "bridge.lock.json"), { force: true }); } catch { /* 忽略 */ }
}
