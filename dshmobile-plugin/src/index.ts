// @liustack/dshmobile-bridge · host 半边
// 职责：
//   1. settings 命名空间 `dshmobile`（连接配置 + 桥状态 + 二维码展示字段）；
//   2. **常驻二维码**：与插件登录态无关，永远可扫——
//      · 有账号密码/会话 → mode=pair（手机扫码登录该账号，方向一）；
//      · 无任何凭据 → mode=grant（匿名出码 + 轮询，手机授权后本机登录，方向二）；
//   3. bridge 子进程守护：账号密码模式或手机授权 token 模式（包内 bridge 支持两种）；
//   4. 注册新账号（registerRequest 通道）。
import { spawn } from "node:child_process";
import { execSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import z from "@deepseek-ai/schemastery";
import { settingsNamespace } from "@deepseek-ai/dsh-settings";

export const name = "dshmobile-bridge";
export const inject = ["settings"];

const NS = settingsNamespace("dshmobile");

const HERE = path.dirname(fileURLToPath(import.meta.url));
const STATE_DIR = path.join(HERE, "..", "state");
const BRIDGE_MAIN = path.join(HERE, "..", "bridge", "main.js");
const CONFIG_FILE = path.join(STATE_DIR, "config.json");
const KEY_FILE = path.join(STATE_DIR, "machine-key.txt");
const SESSION_FILE = path.join(STATE_DIR, "session.json");

const schema = z.object({
  enabled: z.boolean().default(true),
  relayUrl: z.string().default("https://www.deepseek-claudex.cn"),
  username: z.string().default(""),
  password: z.string().default(""),
  deviceLabel: z.string().default("DSH Bridge"),
  // 常驻二维码（两种模式共用一个码位，内容按登录态切换）
  mode: z.string().default("grant"), // "pair" | "grant"
  pairingCode: z.string().default(""),
  pairingExpiresAt: z.string().default(""),
  grantPairingId: z.string().default(""),
  refreshPairing: z.boolean().default(false),
  bridgeStatus: z.string().default("stopped"),
  pairError: z.string().default(""),
  registerRequest: z.string().default(""),
  registerError: z.string().default(""),
  // 退出登录通道：清除本机会话（含手机授权登录的）并转回 grant 模式
  logoutRequest: z.boolean().default(false),
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

interface Session {
  accessToken: string;
  refreshToken: string;
  username: string;
}

function loadSession(): Session | null {
  try {
    if (!existsSync(SESSION_FILE)) return null;
    const s = JSON.parse(readFileSync(SESSION_FILE, "utf8"));
    if (s?.accessToken && s?.refreshToken && s?.username) return s;
  } catch {}
  return null;
}

function saveSession(s: Session) {
  mkdirSync(STATE_DIR, { recursive: true });
  writeFileSync(SESSION_FILE, JSON.stringify(s));
}

export function apply(ctx: any, _config: any = {}) {
  const scope = ctx.settings.register(NS, schema, { applies: "live" });

  let child: ReturnType<typeof spawn> | null = null;
  let stopped = false;
  let session: Session | null = loadSession();
  let grantSecret = ""; // 领取凭证：只存内存，绝不下地
  let pollTimer: ReturnType<typeof setInterval> | null = null;
  let current: z.infer<typeof schema> | null = null;
  let busy = false;

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
          username: value.username || session?.username || "",
          password: value.password || "",
          // 手机授权模式：token 直用（无密码）；账号密码模式：这两个为空
          accessToken: session?.accessToken ?? "",
          refreshToken: session?.refreshToken ?? "",
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
        if (!stopped && code !== null) {
          scope.update({ bridgeStatus: `exited:${code}` }).catch(() => {});
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

  async function restJson(base: string, pathname: string, options: any = {}): Promise<any> {
    const res = await fetch(`${base}${pathname}`, {
      ...options,
      headers: { "content-type": "application/json", ...(options.headers ?? {}) },
    });
    const body: any = await res.json().catch(() => ({}));
    if (!res.ok || body.ok === false) {
      const err: any = new Error(body?.error?.message ?? `HTTP ${res.status}`);
      err.status = res.status;
      throw err;
    }
    return body;
  }

  /** 拿可用 access token：会话优先，否则账号密码登录。 */
  async function obtainAccessToken(base: string): Promise<string> {
    if (session?.accessToken) return session.accessToken;
    const v = current;
    if (!v?.username || !v?.password) {
      throw new Error("本机尚未登录：请用手机 App 扫码授权，或在卡片填写账号密码");
    }
    const login = await restJson(base, "/auth/login", {
      method: "POST",
      body: JSON.stringify({ username: v.username, password: v.password }),
    });
    return login.data.accessToken;
  }

  /** 方向一：账号/会话出码（mode=pair）。 */
  async function ensurePairCode(value: z.infer<typeof schema>) {
    const base = value.relayUrl.replace(/\/$/, "");
    const hasValid =
      value.mode === "pair" &&
      value.pairingCode &&
      value.pairingExpiresAt &&
      new Date(value.pairingExpiresAt).getTime() > Date.now() + 30_000;
    if (hasValid) return;
    try {
      const accessToken = await obtainAccessToken(base);
      let created;
      try {
        created = await restJson(base, "/pairing-codes", {
          method: "POST",
          headers: { authorization: `Bearer ${accessToken}` },
          body: "{}",
        });
      } catch (err: any) {
        if (session?.refreshToken && (err.status === 401 || err.status === 403)) {
          const rf = await restJson(base, "/auth/refresh", {
            method: "POST",
            body: JSON.stringify({ refreshToken: session.refreshToken }),
          });
          session = {
            ...session!,
            accessToken: rf.data.accessToken,
            refreshToken: rf.data.refreshToken ?? session!.refreshToken,
          };
          saveSession(session);
          created = await restJson(base, "/pairing-codes", {
            method: "POST",
            headers: { authorization: `Bearer ${rf.data.accessToken}` },
            body: "{}",
          });
        } else {
          throw err;
        }
      }
      await scope.update({
        mode: "pair",
        pairingCode: created.data.code,
        pairingExpiresAt: created.data.expiresAt,
        grantPairingId: "",
        pairError: "",
      });
    } catch (err: any) {
      await scope.update({ pairError: String(err?.message ?? err) });
    }
  }

  /** 方向二：匿名出码（mode=grant）+ 轮询授权。 */
  async function ensureGrantCode(value: z.infer<typeof schema>) {
    const base = value.relayUrl.replace(/\/$/, "");
    const hasValid =
      value.mode === "grant" &&
      value.pairingCode &&
      value.pairingExpiresAt &&
      new Date(value.pairingExpiresAt).getTime() > Date.now() + 30_000 &&
      value.grantPairingId &&
      grantSecret;
    if (hasValid && pollTimer) return;
    stopPolling();
    try {
      const created = await restJson(base, "/pairing-codes/device", { method: "POST", body: "{}" });
      grantSecret = created.data.requestSecret;
      await scope.update({
        mode: "grant",
        pairingCode: created.data.code,
        pairingExpiresAt: created.data.expiresAt,
        grantPairingId: created.data.id,
        pairError: "",
      });
      startPolling(base, created.data.id);
    } catch (err: any) {
      await scope.update({ pairError: String(err?.message ?? err) });
    }
  }

  function stopPolling() {
    if (pollTimer) {
      clearInterval(pollTimer);
      pollTimer = null;
    }
  }

  function startPolling(base: string, pairingId: string) {
    stopPolling();
    pollTimer = setInterval(async () => {
      if (!grantSecret) return;
      try {
        const res = await restJson(
          base,
          `/pairing-codes/${pairingId}/status?secret=${encodeURIComponent(grantSecret)}`,
          { method: "GET" }
        );
        if (res.data?.status === "granted") {
          stopPolling();
          grantSecret = "";
          session = {
            accessToken: res.data.accessToken,
            refreshToken: res.data.refreshToken,
            username: res.data.user?.username ?? "",
          };
          saveSession(session);
          const v = current;
          await scope.update({
            username: v?.username || session.username,
            mode: "pair",
            pairingCode: "",
            pairingExpiresAt: "",
            grantPairingId: "",
            bridgeStatus: "granted",
          });
          if (v && v.enabled) startBridge(v);
          ensurePairCode(current!).catch(() => {});
        }
      } catch {
        /* 单次轮询失败忽略，下轮重试；码过期由 ensureGrantCode 重新出码 */
      }
    }, 2000);
  }

  /** 常驻二维码总开关：按当前凭据状态选方向。 */
  async function ensureQr(value: z.infer<typeof schema>) {
    if (session || (value.username && value.password)) {
      await ensurePairCode(value);
    } else {
      await ensureGrantCode(value);
    }
  }

  /** 注册新账号（卡片写 registerRequest 触发）。 */
  async function handleRegister(request: string) {
    try {
      const { username: u, password: p } = JSON.parse(request);
      if (!u || !p) throw new Error("账号/密码不能为空");
      const base = (current?.relayUrl ?? "").replace(/\/$/, "");
      await restJson(base, "/auth/register", {
        method: "POST",
        body: JSON.stringify({ username: u, password: p }),
      });
      await scope.update({ registerRequest: "", registerError: "" });
    } catch (err: any) {
      const msg = String(err?.message ?? err);
      const friendly = /already exists/i.test(msg)
        ? "该账号已存在：请点「保存并连接（已有账号）」直接登录"
        : msg;
      await scope.update({ registerRequest: "", registerError: friendly });
    }
  }

  async function onConfig(next: z.infer<typeof schema>) {
    const prev = current;
    current = next;
    if (busy) return;
    busy = true;
    try {
      // 桥启停（配置变化或首次装载）
      const shouldRun = next.enabled && (session !== null || Boolean(next.username && next.password));
      const prevShouldRun = prev
        ? prev.enabled && (session !== null || Boolean(prev.username && prev.password))
        : false;
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
      // 注册新账号
      if (next.registerRequest) {
        await handleRegister(next.registerRequest);
      }
      // 退出登录：清本机会话与账号显示 → 停桥 → 转回授权码模式
      if (next.logoutRequest) {
        session = null;
        grantSecret = "";
        stopPolling();
        try {
          rmSync(SESSION_FILE, { force: true });
        } catch {}
        stopBridge();
        await scope.update({
          logoutRequest: false,
          username: "",
          password: "",
          mode: "grant",
          pairingCode: "",
          pairingExpiresAt: "",
          grantPairingId: "",
          registerError: "",
          pairError: "",
        });
      }
      // 常驻二维码：手动刷新清掉旧码后重出；凭据变化/过期也自动重出
      if (next.refreshPairing) {
        await scope.update({ refreshPairing: false, pairingCode: "", pairingExpiresAt: "" });
      }
      const credsChanged = !prev || prev.username !== next.username || prev.password !== next.password;
      if (next.refreshPairing || credsChanged || !next.pairingCode) {
        await ensureQr(next);
      }
    } finally {
      busy = false;
    }
  }

  const offWatch = scope.watch((next) => {
    onConfig(next).catch(() => {});
  });
  onConfig(scope.get()).catch(() => {});

  return () => {
    stopped = true;
    offWatch();
    stopPolling();
    stopBridge();
  };
}
