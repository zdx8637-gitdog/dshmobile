// 真实 bridge 运行时（ESM）：被 Electron 主进程动态导入。
// 职责：登录/注册设备 → 连 relay → 连 DSH 两条下行流 → 状态回调。
import { readFileSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { hostname } from "node:os";
import os from "node:os";
import { execSync } from "node:child_process";
import crypto from "node:crypto";
import WebSocket from "ws";
import { RelayBridge } from "./src/relay.mjs";
import { DshClient } from "./src/dsh.mjs";
import { Adapter } from "./src/adapter.mjs";

// Electron 33 主进程 = Node 20，无全局 WebSocket；polyfill 后 bridge 模块可用
globalThis.WebSocket = globalThis.WebSocket ?? WebSocket;

const HERE = dirname(fileURLToPath(import.meta.url));

/**
 * 机器稳定标识（与显示名解耦）：
 * 1. 首选 Windows MachineGuid（注册表，改名/换磁盘不影响，重装系统才变）；
 * 2. 读不到时退化为持久化随机 UUID（%LOCALAPPDATA%\dsh-bridge\machine-key.txt）。
 * 旧版用 hostname() 当 key：电脑改名 → key 变 → 服务器产生僵尸行；本函数修复此问题。
 */
function machineGuid() {
  try {
    const out = execSync('reg query "HKLM\\SOFTWARE\\Microsoft\\Cryptography" /v MachineGuid', {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
    const m = out.match(/MachineGuid\s+REG_SZ\s+([0-9a-fA-F-]{36})/);
    if (m) return m[1];
  } catch {}
  return null;
}

function persistedMachineKey() {
  const dir = join(process.env.LOCALAPPDATA || os.tmpdir(), "dsh-bridge");
  const file = join(dir, "machine-key.txt");
  try {
    if (existsSync(file)) {
      const v = readFileSync(file, "utf8").trim();
      if (v) return v;
    }
    mkdirSync(dir, { recursive: true });
    const v = crypto.randomUUID();
    writeFileSync(file, v);
    return v;
  } catch {
    return crypto.randomUUID(); // 最后兜底：本次会话内稳定
  }
}

// 配置定位：开发态 electron/../config.json；打包态 extraResources 解到 process.resourcesPath/config.json
function loadConfig() {
  const candidates = [
    join(process.resourcesPath ?? "", "config.json"),
    join(HERE, "..", "config.json"),
  ];
  for (const p of candidates) {
    if (existsSync(p)) return JSON.parse(readFileSync(p, "utf8"));
  }
  throw new Error("config.json not found");
}

const config = loadConfig();

export class BridgeRuntime {
  constructor({ onState }) {
    this.onState = onState; // (patch: object) => void
    // 设备身份 = 机器稳定标识（MachineGuid），与电脑名/显示名解耦：
    // 改名只更新服务器上同一行的 label，不再产生僵尸行。
    const machineKey = `dsh-bridge-${machineGuid() ?? persistedMachineKey()}`;
    this.relay = new RelayBridge({ ...config.relay, clientDeviceKey: machineKey, stateDir: config.stateDir });
    this.relay.deviceLabel = config.relay.deviceLabel || `DSH Bridge (${hostname()})`;
    this.dsh = new DshClient(config.dsh.url);
    this.adapter = new Adapter({ dsh: this.dsh, relay: this.relay });
    this.stopping = false;
    this.attempt = 0;
  }

  /** 登录 + 注册设备（幂等）。失败抛错。deviceName 覆盖设备显示名。 */
  async login({ server, username, password, deviceName }) {
    this.relay.url = server.replace(/\/$/, "");
    this.relay.username = username;
    this.relay.password = password;
    if (deviceName) this.relay.deviceLabel = deviceName;
    const { deviceId } = await this.relay.provision();
    this.onState({ deviceLabel: this.relay.deviceLabel, lastEvent: `设备已注册 · ${deviceId.slice(0, 13)}…` });
    return deviceId;
  }

  /** 启动：连 relay + 连 DSH 流（各带自动重连）。 */
  start() {
    this.loopRelay();
    this.loopDsh();
  }

  async loopRelay() {
    while (!this.stopping) {
      try {
        this.onState({ relayConnecting: true, relayOnline: false });
        this.relay.onEnvelope = (env) => {
          if (env?.kind === "request" && typeof env.requestId === "string") {
            this.adapter.handleRequest(env).catch((err) => {
              console.error("[adapter] handler error:", err.message);
              this.relay.respond(env.requestId, env.type ?? "unknown", {
                ok: false, error: { code: "internal", message: String(err?.message ?? err) },
              });
            });
          }
        };
        this.relay.connect();
        this.relay.startHeartbeat();
        this.onState({ relayConnecting: false, relayOnline: true, lastEvent: "中继已连接" });
        this.attempt = 0;
        await this.relay.closePromise;
        if (this.relay.isAuthClose()) {
          // 设备被吊销/删除：清 token 重新注册（同 key 自愈，服务器会新建或复用行）
          this.onState({ relayOnline: false, lastEvent: "设备凭证失效，重新注册…" });
          this.relay.deviceToken = null;
          await this.relay.provision();
        }
      } catch (err) {
        this.onState({ relayOnline: false, relayConnecting: false, lastEvent: `中继连接失败: ${err.message}` });
        this.attempt += 1;
      }
      if (this.stopping) break;
      const delay = Math.min(30000, 1000 * 2 ** Math.min(this.attempt, 5));
      await new Promise((r) => setTimeout(r, delay));
    }
  }

  async loopDsh() {
    let streams = [];
    while (!this.stopping) {
      this.onState({ dshConnecting: true, dshOnline: false });
      streams = [
        this.dsh.openStream("/api/events.mux", (f) => this.adapter.handleMuxFrame(f), () => {}),
        this.dsh.openStream("/api/events.host", (f) => this.adapter.handleHostFrame(f), () => {}),
      ];
      this.onState({ dshConnecting: false, dshOnline: true, lastEvent: "已连接本地 DSH" });
      // 等任一断开
      while (!this.stopping) {
        if (streams.some((ws) => ws.readyState === WebSocket.CLOSED)) break;
        await new Promise((r) => setTimeout(r, 1000));
      }
      streams.forEach((ws) => { try { ws.close(); } catch {} });
      if (this.stopping) break;
      this.onState({ dshOnline: false, lastEvent: "DSH 连接断开，重连中…" });
      await new Promise((r) => setTimeout(r, 1500));
    }
  }

  stop() {
    this.stopping = true;
    try { this.relay.ws?.close(); } catch {}
  }
}
