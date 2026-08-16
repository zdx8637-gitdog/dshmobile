// @liustack/dshmobile-bridge · host 半边
// 职责：
//   1. 注册 settings 命名空间 `dshmobile`（连接配置 + 桥状态 + 配对码展示字段）；
//   2. bridge 子进程守护：按配置启停（spawn 包内 bridge/main.js，配置经
//      DSHMOBILE_BRIDGE_CONFIG 环境变量注入，协议与独立版 bridge 完全一致）；
//   3. 扫码登录（方向一）出码：客户端卡写 refreshPairing=true → 此处登录 relay
//      生成一次性配对码 → 写回命名空间，卡片展示二维码；手机核销链路复用 S1。
import { spawn } from "node:child_process";
import { execSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { settingsNamespace } from "@deepseek-ai/dsh-settings";

export const name = "dshmobile-bridge";
export const inject = ["settings"];

const NS = settingsNamespace("dshmobile");

const HERE = path.dirname(fileURLToPath(import.meta.url));
const STATE_DIR = path.join(HERE, "..", "state");
const BRIDGE_MAIN = path.join(HERE, "..", "bridge", "main.js");
const CONFIG_FILE = path.join(STATE_DIR, "config.json");
const KEY_FILE = path.join(STATE_DIR, "machine-key.txt");

const schema = z.object({
  enabled: z.boolean().default(true),
  relayUrl: z.string().default("https://www.deepseek-claudex.cn"),
  username: z.string().default(""),
  password: z.string().default(""),
  deviceLabel: z.string().default("DSH Bridge"),
  pairingCode: z.string().default(""),
  pairingExpiresAt: z.string().default(""),
  refreshPairing: z.boolean().default(false),
  bridgeStatus: z.string().default("stopped"),
});

/** 机器稳定标识：Windows MachineGuid，读不到则持久化随机 UUID（与显示名解耦）。 */
function machineGuid(): string | null {
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

function stableMachineKey(): string {
  const guid = machineGuid();
  if (guid) return `dsh-bridge-${guid}`;
  try {
    if (existsSync(KEY_FILE)) {
      const v = readFileSync(KEY_FILE, "utf8").trim();
      if (v) return v;
    }
    mkdirSync(STATE_DIR, { recursive: true });
    const v = `dsh-bridge-${crypto.randomUUID()}`;
    writeFileSync(KEY_FILE, v);
    return v;
  } catch {
    return `dsh-bridge-${Math.random().toString(36).slice(2)}`;
  }
}

export function apply(ctx: any, _config: any = {}) {
  const scope = ctx.settings.register(NS, schema, { applies: "live" });

  let child: ReturnType<typeof spawn> | null = null;
  let stopped = false;

  function stopBridge() {
    if (child) {
      const p = child;
      child = null;
      try { p.kill(); } catch {}
    }
    scope.update({ bridgeStatus: "stopped" }).catch(() => {});
  }

  function startBridge(value: z.infer<typeof schema>) {
    stopBridge();
    try {
      mkdirSync(STATE_DIR, { recursive: true });
      const cfg = {
        relay: {
          url: value.relayUrl,
          username: value.username,
          password: value.password,
          deviceLabel: value.deviceLabel || "DSH Bridge",
          platform: "windows",
          clientDeviceKey: stableMachineKey(),
        },
        dsh: { url: "http://127.0.0.1:3080" },
        stateDir: STATE_DIR,
      };
      writeFileSync(CONFIG_FILE, JSON.stringify(cfg, null, 2));
      child = spawn(process.execPath, [BRIDGE_MAIN], {
        env: { ...process.env, DSHMOBILE_BRIDGE_CONFIG: CONFIG_FILE },
        stdio: "ignore",
      });
      child.on("exit", (code) => {
        // 主动 kill 的 code 为 null（stopBridge 已写 "stopped"），只有真实退出才覆盖
        if (!stopped && code !== null) {
          scope
            .update({ bridgeStatus: `exited:${code}` })
            .catch(() => {});
        }
      });
      child.on("error", (err) => {
        scope.update({ bridgeStatus: `error:${err.message}` }).catch(() => {});
      });
      scope.update({ bridgeStatus: "running" }).catch(() => {});
    } catch (err: any) {
      scope.update({ bridgeStatus: `error:${err?.message ?? err}` }).catch(() => {});
    }
  }

  /** 扫码登录（方向一）：登录 relay → 出 6 位配对码 → 写回命名空间供卡片展示。 */
  async function generatePairing(value: z.infer<typeof schema>) {
    const base = value.relayUrl.replace(/\/$/, "");
    try {
      const loginRes = await fetch(`${base}/auth/login`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ username: value.username, password: value.password }),
      });
      const login: any = await loginRes.json();
      if (!loginRes.ok || login.ok === false) throw new Error("登录失败，无法出码");

      const createRes = await fetch(`${base}/pairing-codes`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${login.data.accessToken}`,
        },
        body: "{}",
      });
      const created: any = await createRes.json();
      if (!createRes.ok || created.ok === false) throw new Error("出码失败");

      await scope.update({
        pairingCode: created.data.code,
        pairingExpiresAt: created.data.expiresAt,
        refreshPairing: false,
      });
    } catch (err: any) {
      await scope.update({
        refreshPairing: false,
        pairingCode: "",
        pairingExpiresAt: "",
        bridgeStatus: `pair-fail:${err?.message ?? err}`,
      });
    }
  }

  let current: z.infer<typeof schema> | null = null;
  let busy = false;

  async function onConfig(next: z.infer<typeof schema>) {
    const prev = current;
    current = next;
    if (busy) return;
    busy = true;
    try {
      // 桥启停（配置变化或首次装载）
      const shouldRun = next.enabled && next.username && next.password;
      const prevShouldRun = prev ? prev.enabled && prev.username && prev.password : false;
      const cfgChanged =
        !prev ||
        prev.relayUrl !== next.relayUrl ||
        prev.username !== next.username ||
        prev.password !== next.password ||
        prev.deviceLabel !== next.deviceLabel ||
        prev.enabled !== next.enabled;
      if (cfgChanged || (!child && shouldRun)) {
        if (shouldRun) startBridge(next);
        else stopBridge();
      }
      // 配对码刷新
      if (next.refreshPairing) {
        await generatePairing(next);
      }
    } finally {
      busy = false;
    }
  }

  const offWatch = scope.watch((next) => {
    onConfig(next).catch(() => {});
  });
  // 初始装载：带默认值触发一次
  onConfig(scope.get()).catch(() => {});

  return () => {
    stopped = true;
    offWatch();
    stopBridge();
  };
}
