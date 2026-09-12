// DSH bridge 入口：provision 设备 → 连 relay → 连 DSH 两条下行流 → 事件泵。
// 断线自动重连（指数退避）。
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { RelayBridge } from "./relay.js";
import { DshClient } from "./dsh.js";
import { Adapter } from "./adapter.js";
import { E2eeSession } from "./e2ee.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const configPath = process.env.DSHMOBILE_BRIDGE_CONFIG || join(HERE, "..", "config.json");
const config = JSON.parse(readFileSync(configPath, "utf8"));

const e2ee = new E2eeSession({ stateDir: config.stateDir });
const relay = new RelayBridge({ ...config.relay, stateDir: config.stateDir, e2ee });
const dsh = new DshClient(config.dsh.url, { stateDir: config.stateDir, token: config.dsh?.token ?? "" });
// Data plane 落盘根目录：默认 <stateDir>/deliveries（可在 config.dsh.workspaceRoot 覆盖）
const workspaceRoot = config.dsh?.workspaceRoot || join(config.stateDir || ".", "deliveries");
const adapter = new Adapter({ dsh, relay, workspaceRoot, e2ee });

let mux = null;
let stopping = false;

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

/** 等协议探测完成（老 DSH→legacy / 新 DSH→v2）；DSH 未就绪时退避重试。 */
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

/** legacy：连 DSH mux + host 两条只读下行流，断裂后自动重建。 */
async function legacyStreamLoop() {
  let attempt = 0;
  while (!stopping) {
    const streams = [
      dsh.openStream("/api/events.mux", (frame) => adapter.handleMuxFrame(frame), () => {}),
      dsh.openStream("/api/events.host", (frame) => adapter.handleHostFrame(frame), () => {}),
    ];
    // 等其中一条关闭再重连（简化：轮询 readyState）
    while (!stopping) {
      const closed = streams.some((ws) => ws.readyState === WebSocket.CLOSED);
      if (closed) break;
      await sleep(1000);
    }
    if (stopping) break;
    attempt += 1;
    const delay = Math.min(10000, 500 * 2 ** Math.min(attempt, 4));
    console.warn(`[dsh] legacy stream lost, reconnect in ${delay}ms (attempt ${attempt})`);
    streams.forEach((ws) => { try { ws.close(); } catch {} });
    await sleep(delay);
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

process.on("SIGINT", () => {
  stopping = true;
  try { mux?.close(); } catch {}
  try { relay.ws?.close(); } catch {}
  setTimeout(() => process.exit(0), 500);
});

console.log("[bridge] starting: DSH", config.dsh.url, "-> relay", config.relay.url);
await waitProtocol();
await Promise.all([relayLoop(), dsh.protocol === "legacy" ? legacyStreamLoop() : dshStreamLoop()]);
