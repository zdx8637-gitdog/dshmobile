// DSH bridge 入口：provision 设备 → 连 relay → 连 DSH 两条下行流 → 事件泵。
// 断线自动重连（指数退避）。
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { RelayBridge } from "./relay.js";
import { DshClient } from "./dsh.js";
import { Adapter } from "./adapter.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const configPath = process.env.DSHMOBILE_BRIDGE_CONFIG || join(HERE, "..", "config.json");
const config = JSON.parse(readFileSync(configPath, "utf8"));

const relay = new RelayBridge({ ...config.relay, stateDir: config.stateDir });
const dsh = new DshClient(config.dsh.url);
const adapter = new Adapter({ dsh, relay });

let dshStreams = [];
let stopping = false;

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

/** 连 DSH mux + host 两条只读下行流，断裂后自动重建。 */
async function dshStreamLoop() {
  let attempt = 0;
  while (!stopping) {
    dshStreams = [];
    dshStreams.push(dsh.openStream("/api/events.mux", (frame) => adapter.handleMuxFrame(frame), () => {}));
    dshStreams.push(dsh.openStream("/api/events.host", (frame) => adapter.handleHostFrame(frame), () => {}));

    // 等其中一条关闭再重连（简化：轮询 readyState）
    while (!stopping) {
      const closed = dshStreams.some((ws) => ws.readyState === WebSocket.CLOSED);
      if (closed) break;
      await sleep(1000);
    }
    if (stopping) break;
    attempt += 1;
    const delay = Math.min(10000, 500 * 2 ** Math.min(attempt, 4));
    console.warn(`[dsh] stream lost, reconnect in ${delay}ms (attempt ${attempt})`);
    dshStreams.forEach((ws) => { try { ws.close(); } catch {} });
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
      }
      relay.onEnvelope = (env) => {
        if (env?.kind === "request" && typeof env.requestId === "string") {
          adapter.handleRequest(env).catch((err) => {
            console.error("[adapter] handler error:", err.message);
            relay.respond(env.requestId, env.type ?? "unknown", { ok: false, error: { code: "internal", message: String(err?.message ?? err) } });
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
  dshStreams.forEach((ws) => { try { ws.close(); } catch {} });
  try { relay.ws?.close(); } catch {}
  setTimeout(() => process.exit(0), 500);
});

console.log("[bridge] starting: DSH", config.dsh.url, "-> relay", config.relay.url);
await Promise.all([relayLoop(), dshStreamLoop()]);
