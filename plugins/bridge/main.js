// DSH bridge 入口：provision 设备 → 连 relay → 连 DSH 两条下行流 → 事件泵。
// 断线自动重连（指数退避）。
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { RelayBridge } from "./relay.js";
import { DshClient } from "./dsh.js";
import { Adapter } from "./adapter.js";
import { E2eeSession } from "./e2ee.js";
import {
  claimSingleton,
  isSingletonEnabled,
  writeSingletonInfo,
  clearSingletonInfo,
  EXIT_ANOTHER_INSTANCE,
  EXIT_YIELDED,
} from "./singleton.js";
import { killOtherBridges } from "./scan.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const configPath = process.env.DSHMOBILE_BRIDGE_CONFIG || join(HERE, "..", "config.json");
const config = JSON.parse(readFileSync(configPath, "utf8"));

// 宿主会带上 --state-dir=<目录> 作为命令行标记（宿主据此精确接管同身份残留桥）；这里只做一致性校验。
const stateDirArg = process.argv.find((a) => a.startsWith("--state-dir="));
if (stateDirArg && config.stateDir && stateDirArg.slice("--state-dir=".length) !== config.stateDir) {
  console.warn("[bridge] 警告：命令行 --state-dir 与 config.stateDir 不一致（按 config 执行）");
}

const e2ee = new E2eeSession({ stateDir: config.stateDir });
const relay = new RelayBridge({ ...config.relay, stateDir: config.stateDir, e2ee });

// 自愈：连续被顶替说明本机还有另一个桥（多半是老版本/孤儿，不认识单例锁）→ 主动清掉它。
// 单例锁保证"新版本桥"之间不会并存；这里兜住"新旧混跑"和"别的目录装的老桥"。
let duplicateKicks = [];
let lastReapAt = 0;
relay.onDuplicateKick = () => {
  const now = Date.now();
  duplicateKicks = duplicateKicks.filter((t) => now - t < 120_000);
  duplicateKicks.push(now);
  if (duplicateKicks.length < 3 || now - lastReapAt < 300_000) return;
  lastReapAt = now;
  duplicateKicks = [];
  console.warn("[scan] 连续 3 次被其它桥顶替：尝试清理本机其它桥进程…");
  try {
    killOtherBridges({ stateDir: config.stateDir });
  } catch (err) {
    console.warn("[scan] 清理失败：", err?.message ?? err);
  }
};
const dsh = new DshClient(config.dsh.url, { stateDir: config.stateDir, token: config.dsh?.token ?? "" });
// Data plane 落盘根目录：默认 <stateDir>/deliveries（可在 config.dsh.workspaceRoot 覆盖）
const workspaceRoot = config.dsh?.workspaceRoot || join(config.stateDir || ".", "deliveries");
const adapter = new Adapter({ dsh, relay, workspaceRoot, e2ee });

let mux = null;
let stopping = false;
let singleton = null; // { ok, server, port, tookOver }

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

/** 统一退出路径：清诊断文件 + 关流，避免留下孤儿桥（单例端口随进程退出自动释放）。 */
function shutdown(code, why) {
  if (stopping) return;
  stopping = true;
  console.warn(`[bridge] 退出（code=${code}）：${why}`);
  try { clearSingletonInfo(config.stateDir); } catch { /* 忽略 */ }
  try { mux?.close(); } catch { /* 已关 */ }
  try { relay.ws?.close(); } catch { /* 已关 */ }
  try { singleton?.server?.close(); } catch { /* 已关 */ }
  setTimeout(() => process.exit(code), 300);
}

/**
 * 单实例保护：同一 stateDir 只允许一个桥在跑（否则同一个 relay 设备标识会被两条连接互相顶替）。
 * 抢不到 → 以退出码 42 退出（宿主据此不自动重启，避免两个宿主互相重启）。
 */
async function ensureSingleton() {
  if (!isSingletonEnabled()) {
    console.warn("[singleton] 单实例保护已按 DSHMOBILE_BRIDGE_SINGLETON 关闭（仅供临时第二桥/测试使用）");
    return;
  }
  const r = await claimSingleton({
    stateDir: config.stateDir,
    onYield: () => shutdown(EXIT_YIELDED, "已让位给新启动的桥实例"),
  });
  if (!r.ok) {
    console.error(
      `[singleton] ${r.reason}（回环端口 ${r.port}）。本进程退出，避免与已有桥互相顶替。` +
        "若确认没有别的桥在运行，请结束残留的 node 进程（命令行含 bridge/main.js）后重启 DSH。",
    );
    process.exit(EXIT_ANOTHER_INSTANCE);
  }
  singleton = r;
  writeSingletonInfo(config.stateDir, r);
  console.log(`[singleton] 已持有单实例锁（127.0.0.1:${r.port}）${r.tookOver ? "，旧实例已让位" : ""}`);
}

/** 等协议探测完成（只支持新 DSH / v2）；DSH 未就绪时退避重试。 */
async function waitProtocol() {
  while (!stopping) {
    try {
      await dsh.ensureProtocol();
      console.log("[bridge] protocol:", dsh.protocol, "DSH", config.dsh.url, "-> relay", config.relay.url);
      return;
    } catch (err) {
      console.warn("[bridge] protocol probe failed:", err?.message ?? err, "- retry in 3s");
      await sleep(3000);
    }
  }
}


/** v2：连 DSH /api/remote.mux（鉴权 + 全部逻辑流复用），断裂后自动重建。 */
async function dshStreamLoop() {
  let attempt = 0;
  while (!stopping) {
    try {
      // openMux 返回后由 adapter 挂载 $events / session/control / workspace/follow / 各会话 follow；
      // 物理连接关闭（含鉴权失败）时回调唤醒本循环退避重连。
      await new Promise((resolve) => {
        mux = dsh.openMux(() => resolve());
        adapter.attachMux(mux);
      });
    } catch (err) {
      console.warn("[dsh] mux setup failed:", err?.message ?? err);
    }
    if (stopping) break;
    attempt += 1;
    const delay = Math.min(10000, 500 * 2 ** Math.min(attempt, 4));
    console.warn(`[dsh] mux lost, reconnect in ${delay}ms (attempt ${attempt})`);
    await sleep(delay);
  }
}

/** 连 relay，断裂后指数退避重连（设备令牌复用，不重复 provision）。 */
async function relayLoop() {
  let attempt = 0;
  while (!stopping) {
    try {
      if (!relay.deviceToken) {
        const { deviceId } = await relay.provision();
        console.log("[relay] provisioned device:", deviceId);
        // 回写 deviceId 供宿主出「加密配对」二维码使用（码里带设备 ID，手机才能连对设备）
        try {
          writeFileSync(join(config.stateDir, "device-id.json"), JSON.stringify({ deviceId }, null, 2));
        } catch {}
      }
      relay.onEnvelope = (env) => {
        const plain = relay.decryptEnvelope(env);
        if (plain?.kind === "request" && typeof plain.requestId === "string") {
          adapter.handleRequest(plain).catch((err) => {
            console.error("[adapter] handler error:", err.message);
            relay.respond(plain.requestId, plain.type ?? "unknown", { ok: false, error: { code: "internal", message: String(err?.message ?? err) } });
          });
        }
      };
      relay.connect();
      relay.startHeartbeat(); // 幂等？改为一次性：见下方 guard
      await relay.closePromise; // 等断开
      if (relay.isAuthClose()) {
        // 设备被吊销/删除：清 token，下一轮循环重新注册（同 key 自愈：新行或复用行）。
        console.warn("[relay] auth rejected (", relay.lastCloseCode, relay.lastCloseReason, "), re-provisioning…");
        relay.deviceToken = null;
      }
      if (stopping) break;
      attempt += 1;
      const delay = Math.min(30000, 1000 * 2 ** Math.min(attempt, 5));
      console.warn(`[relay] disconnected, reconnect in ${delay}ms (attempt ${attempt})`);
      await sleep(delay);
    } catch (err) {
      console.error("[relay] provision/connect failed:", err.message);
      attempt += 1;
      const delay = Math.min(30000, 1000 * 2 ** Math.min(attempt, 5));
      await sleep(delay);
    }
  }
}

process.on("SIGINT", () => shutdown(0, "收到 SIGINT（终端/宿主要求停止）"));
process.on("SIGTERM", () => shutdown(0, "收到 SIGTERM"));

// 父进程看门狗：宿主用 IPC 通道拉起本进程，父进程消失时该通道关闭 → 本进程必须跟着退出。
// 否则它会变成"孤儿桥"：与下一次 DSH 启动的桥共用同一份 config/设备标识，在 relay 侧互相顶替。
process.on("disconnect", () => shutdown(0, "父进程（DSH 插件宿主）已消失（IPC 通道关闭）"));

console.log("[bridge] starting: DSH", config.dsh.url, "-> relay", config.relay.url);
await ensureSingleton();
await waitProtocol();
await Promise.all([relayLoop(), dshStreamLoop()]);
