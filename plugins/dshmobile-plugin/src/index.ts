// @zdx8637/dshmobile-bridge · host 半边
// 更名记录：@liustack/dshmobile-bridge → @zdx8637/dshmobile-bridge（改用自有 scope 以便发布 npm 社区）
// 职责：
//   1. **常驻二维码**：与插件登录态无关，永远可扫——
//      · 有账号密码/会话 → mode=pair（手机扫码登录该账号，方向一）；
//      · 无任何凭据 → mode=grant（匿名出码 + 轮询，手机授权后本机登录，方向二）；
//   2. bridge 子进程守护：账号密码模式或手机授权 token 模式（包内 bridge 支持两种）；
//   3. 注册新账号。
// 数据通道：不再走 DSH settings 命名空间（rc.6 不对浏览器暴露第三方命名空间），
// 改为 127.0.0.1 本地 HTTP：Web 面板 GET /state 轮询 + POST /action 下发动作。
// 收益：一条命令安装即用、跨平台、DSH 升级不受影响、无需任何本地补丁。
import { spawn } from "node:child_process";
import { execSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const name = "dshmobile-bridge";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const STATE_DIR = process.env.DSHMOBILE_STATE_DIR || path.join(HERE, "..", "state");
const BRIDGE_MAIN = path.join(HERE, "..", "bridge", "main.js");
const CONFIG_FILE = path.join(STATE_DIR, "config.json");
const KEY_FILE = path.join(STATE_DIR, "machine-key.txt");
const SESSION_FILE = path.join(STATE_DIR, "session.json");
const PANEL_FILE = path.join(STATE_DIR, "panel.json");
const HTTP_PORT = parseInt(process.env.DSHMOBILE_HTTP_PORT ?? "17653", 10);

interface PanelState {
  enabled: boolean;
  relayUrl: string;
  username: string;
  password: string;
  deviceLabel: string;
  // 常驻二维码（两种模式共用一个码位，内容按登录态切换）
  mode: string; // "pair" | "grant"
  pairingCode: string;
  pairingExpiresAt: string;
  grantPairingId: string;
  bridgeStatus: string;
  pairError: string;
  registerError: string;
}

function defaultState(): PanelState {
  return {
    enabled: true,
    relayUrl: "https://www.deepseek-claudex.cn",
    username: "",
    password: "",
    deviceLabel: "DSH Bridge",
    mode: "grant",
    pairingCode: "",
    pairingExpiresAt: "",
    grantPairingId: "",
    bridgeStatus: "stopped",
    pairError: "",
    registerError: "",
  };
}

/** 面板配置持久化（仅用户可编辑字段；二维码/状态等运行时字段不落盘）。 */
function loadPanelState(): Partial<PanelState> {
  try {
    if (!existsSync(PANEL_FILE)) return {};
    const v = JSON.parse(readFileSync(PANEL_FILE, "utf8"));
    const out: Record<string, unknown> = {};
    for (const k of ["enabled", "relayUrl", "username", "password", "deviceLabel"]) {
      if (typeof v[k] === "string" || typeof v[k] === "boolean") out[k] = v[k];
    }
    return out;
  } catch {
    return {};
  }
}

function savePanelState(s: PanelState) {
  try {
    mkdirSync(STATE_DIR, { recursive: true });
    writeFileSync(
      PANEL_FILE,
      JSON.stringify({
        enabled: s.enabled,
        relayUrl: s.relayUrl,
        username: s.username,
        password: s.password,
        deviceLabel: s.deviceLabel,
      }),
    );
  } catch (err: any) {
    console.error("[dshmobile] persist panel state failed:", err?.message);
  }
}

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

export function apply(_ctx: any, _config: any = {}) {
  let state: PanelState = { ...defaultState(), ...loadPanelState() };

  let child: ReturnType<typeof spawn> | null = null;
  let stopped = false;
  let session: Session | null = loadSession();
  let grantSecret = ""; // 领取凭证：只存内存，绝不下地
  let pollTimer: ReturnType<typeof setInterval> | null = null;
  let lastConfig: PanelState | null = null;

  function patchState(patch: Partial<PanelState>) {
    state = { ...state, ...patch };
  }

  /** 串行化配置处理：动作并发时按到达顺序执行，避免旧快照覆盖。 */
  let chain: Promise<void> = Promise.resolve();
  function scheduleConfig() {
    chain = chain
      .then(() => onConfig())
      .catch((err) => console.error("[dshmobile] config error:", err?.message ?? err));
  }

  function stopBridge() {
    if (child) {
      const p = child;
      child = null;
      try { p.kill(); } catch {}
    }
    patchState({ bridgeStatus: "stopped" });
  }

  function startBridge(value: PanelState) {
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
          patchState({ bridgeStatus: `exited:${code}` });
        }
      });
      child.on("error", (err) => {
        patchState({ bridgeStatus: `error:${err.message}` });
      });
      patchState({ bridgeStatus: "running" });
    } catch (err: any) {
      patchState({ bridgeStatus: `error:${err?.message ?? err}` });
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
    if (!state.username || !state.password) {
      throw new Error("本机尚未登录：请用手机 App 扫码授权，或在卡片填写账号密码");
    }
    const login = await restJson(base, "/auth/login", {
      method: "POST",
      body: JSON.stringify({ username: state.username, password: state.password }),
    });
    return login.data.accessToken;
  }

  /** 方向一：账号/会话出码（mode=pair）。 */
  async function ensurePairCode() {
    const base = state.relayUrl.replace(/\/$/, "");
    const hasValid =
      state.mode === "pair" &&
      state.pairingCode &&
      state.pairingExpiresAt &&
      new Date(state.pairingExpiresAt).getTime() > Date.now() + 30_000;
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
      patchState({
        mode: "pair",
        pairingCode: created.data.code,
        pairingExpiresAt: created.data.expiresAt,
        grantPairingId: "",
        pairError: "",
      });
    } catch (err: any) {
      // 二维码永远在：账号密码错时不卡死，回退为授权二维码（手机扫码授权本机登录）
      patchState({
        pairError: `账号密码错误（${String(err?.message ?? err)}），已切换为授权二维码：用手机 App 扫码即可授权本机登录`,
      });
      await ensureGrantCode();
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
          { method: "GET" },
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
          patchState({
            username: state.username || session.username,
            mode: "pair",
            pairingCode: "",
            pairingExpiresAt: "",
            grantPairingId: "",
            bridgeStatus: "granted",
          });
          if (state.enabled) startBridge(state);
          ensurePairCode().catch(() => {});
        }
      } catch {
        /* 单次轮询失败忽略，下轮重试；码过期由面板刷新或配置变化重新出码 */
      }
    }, 2000);
  }

  /** 方向二：匿名出码（mode=grant）+ 轮询授权。 */
  async function ensureGrantCode() {
    const base = state.relayUrl.replace(/\/$/, "");
    const hasValid =
      state.mode === "grant" &&
      state.pairingCode &&
      state.pairingExpiresAt &&
      new Date(state.pairingExpiresAt).getTime() > Date.now() + 30_000 &&
      state.grantPairingId &&
      grantSecret;
    if (hasValid && pollTimer) return;
    stopPolling();
    try {
      const created = await restJson(base, "/pairing-codes/device", { method: "POST", body: "{}" });
      grantSecret = created.data.requestSecret;
      patchState({
        mode: "grant",
        pairingCode: created.data.code,
        pairingExpiresAt: created.data.expiresAt,
        grantPairingId: created.data.id,
        pairError: "",
      });
      startPolling(base, created.data.id);
    } catch (err: any) {
      const msg = String(err?.message ?? err);
      patchState({ pairError: msg });
      // 触发限流时自动延时重试（二维码永远会补回来）
      if (/too many/i.test(msg)) {
        setTimeout(() => {
          ensureGrantCode().catch(() => {});
        }, 15_000);
      }
    }
  }

  /** 常驻二维码总开关：按当前凭据状态选方向。 */
  async function ensureQr() {
    if (session || (state.username && state.password)) {
      await ensurePairCode();
    } else {
      await ensureGrantCode();
    }
  }

  /** 注册新账号（面板「注册并连接」触发）。 */
  async function handleRegister(username: string, password: string) {
    try {
      const base = state.relayUrl.replace(/\/$/, "");
      await restJson(base, "/auth/register", {
        method: "POST",
        body: JSON.stringify({ username, password }),
      });
      patchState({ registerError: "" });
    } catch (err: any) {
      const msg = String(err?.message ?? err);
      const friendly = /already exists/i.test(msg)
        ? "该账号已存在：请点「保存并连接（已有账号）」直接登录"
        : msg;
      patchState({ registerError: friendly });
    }
  }

  /** 退出登录：清本机会话与账号显示 → 停桥 → 转回授权码模式。 */
  async function handleLogout() {
    session = null;
    grantSecret = "";
    stopPolling();
    try {
      rmSync(SESSION_FILE, { force: true });
    } catch {}
    stopBridge();
    patchState({
      username: "",
      password: "",
      mode: "grant",
      pairingCode: "",
      pairingExpiresAt: "",
      grantPairingId: "",
      registerError: "",
      pairError: "",
    });
    savePanelState(state);
    scheduleConfig();
  }

  async function onConfig() {
    const next = { ...state };
    const prev = lastConfig;
    lastConfig = next;
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
    // 常驻二维码：凭据变化/尚无有效码时（重新）出码
    const credsChanged = !prev || prev.username !== next.username || prev.password !== next.password;
    if (credsChanged || !next.pairingCode) {
      await ensureQr();
    }
  }

  /** 面板动作分发。 */
  async function handleAction(action: string, payload: any) {
    switch (action) {
      case "save": {
        for (const k of ["relayUrl", "username", "password", "deviceLabel", "enabled"]) {
          if (payload && payload[k] !== undefined) (state as any)[k] = payload[k];
        }
        savePanelState(state);
        scheduleConfig();
        break;
      }
      case "register": {
        const u = String(payload?.username ?? "").trim();
        const p = String(payload?.password ?? "");
        if (!u || !p) throw new Error("账号/密码不能为空");
        state.username = u;
        state.password = p;
        savePanelState(state);
        handleRegister(u, p).catch((err) => console.error("[dshmobile] register error:", err?.message ?? err));
        scheduleConfig();
        break;
      }
      case "logout": {
        await handleLogout();
        break;
      }
      case "refreshPairing": {
        patchState({ pairingCode: "", pairingExpiresAt: "" });
        scheduleConfig();
        break;
      }
      default:
        throw new Error("unknown action: " + action);
    }
  }

  /** 127.0.0.1 本地 HTTP 服务：面板轮询 /state、下发 /action（CORS 仅放行本机来源）。 */
  function startServer() {
    const server = createServer((req, res) => {
      const origin = String(req.headers.origin ?? "");
      const corsOk = /^https?:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/i.test(origin);
      const headers: Record<string, string> = {
        "Access-Control-Allow-Origin": corsOk ? origin : "null",
        "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
        "Access-Control-Allow-Headers": "Content-Type",
        "Content-Type": "application/json; charset=utf-8",
        "Cache-Control": "no-store",
      };
      if (req.method === "OPTIONS") {
        res.writeHead(204, headers);
        res.end();
        return;
      }
      const send = (code: number, body: any) => {
        res.writeHead(code, headers);
        res.end(JSON.stringify(body));
      };
      const url = new URL(req.url ?? "/", "http://127.0.0.1");
      if (req.method === "GET" && url.pathname === "/state") {
        send(200, { ok: true, data: state });
        return;
      }
      if (req.method === "POST" && url.pathname === "/action") {
        let raw = "";
        req.on("data", (c) => { raw += c; });
        req.on("end", () => {
          (async () => {
            try {
              const body = JSON.parse(raw || "{}");
              await handleAction(body.action, body.payload);
              send(200, { ok: true });
            } catch (err: any) {
              send(200, { ok: false, error: { message: String(err?.message ?? err) } });
            }
          })();
        });
        return;
      }
      send(404, { ok: false, error: { message: "not found" } });
    });
    server.on("error", (err: any) => {
      console.error(`[dshmobile] panel http server error (port ${HTTP_PORT}):`, err?.message ?? err);
    });
    server.listen(HTTP_PORT, "127.0.0.1");
    return server;
  }

  const server = startServer();
  scheduleConfig(); // 首次装载：按持久化配置启动桥 + 出码

  return () => {
    stopped = true;
    stopPolling();
    stopBridge();
    try { server.close(); } catch {}
  };
}
