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
import { randomUUID } from "node:crypto";
import { appendFileSync, closeSync, copyFileSync, existsSync, mkdirSync, openSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { homedir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { generateIdentityKeypair, randomPairingSecret } from "../bridge/crypto.js";
import { killOtherBridges } from "../bridge/scan.js";

export const name = "dshmobile-bridge";

const HERE = path.dirname(fileURLToPath(import.meta.url));
// 状态目录放在用户主目录（与包目录解耦）：插件升级/重装不会丢登录态与面板配置。
const STATE_DIR = process.env.DSHMOBILE_STATE_DIR || path.join(homedir(), ".dsh-mobile");
const BRIDGE_MAIN = path.join(HERE, "..", "bridge", "main.js");
// 传给桥的命令行标记：既是"同一 relay 身份（同一 stateDir）"的显式标识，也供宿主精确接管残留桥进程。
const BRIDGE_STATE_MARKER = `--state-dir=${STATE_DIR}`;
// 桥的退出码约定（见 bridge/singleton.js）：抢不到单例 / 已让位 → 宿主**不得**自动重启，
// 否则两个宿主会互相重启、互相顶替。
const BRIDGE_EXIT_ANOTHER_INSTANCE = 42;
const BRIDGE_EXIT_YIELDED = 43;
// 桥"让位/被占用"后的礼貌重试：对方（可能是另一个 DSH 实例的桥）还活着就继续等，
// 对方消失就自动接管。带上 --no-yield，绝不会反过来要求对方让位 → 不会形成宿主互踢。
const YIELD_RETRY_MS = 60_000;
const MAX_FAST_YIELD_RETRIES = 5;
const SLOW_YIELD_RETRY_MS = 600_000;
const CONFIG_FILE = path.join(STATE_DIR, "config.json");
const KEY_FILE = path.join(STATE_DIR, "machine-key.txt");
const SESSION_FILE = path.join(STATE_DIR, "session.json");
const PANEL_FILE = path.join(STATE_DIR, "panel.json");
const DEVICE_KEY_FILE = path.join(STATE_DIR, "device-key.json");
const PAIRING_FILE = path.join(STATE_DIR, "pairing.json");
const HTTP_PORT = parseInt(process.env.DSHMOBILE_HTTP_PORT ?? "17653", 10);
// 加密配对码（第二个码）TTL：独立于登录码，15 分钟足够完成「扫码→连设备→握手」。
const E2EE_PAIRING_TTL_MS = 900_000;

/** 读取包版本号（package.json），供面板显示「当前 bridge 版本」。 */
function readPackageVersion(): string {
  try {
    const p = JSON.parse(readFileSync(path.join(HERE, "..", "package.json"), "utf8"));
    return typeof p?.version === "string" ? p.version : "";
  } catch {
    return "";
  }
}
const BRIDGE_VERSION = readPackageVersion();


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
  e2eePubKey: string;
  e2eePairingSecret: string;
  e2eeCryptoVersion: number;
  // 加密配对（第二个码）：独立 pairingId + 过期时间 + 设备 ID
  e2eePairingId: string;
  e2eePairingExpiresAt: string;
  e2eeDeviceId: string;
  bridgeVersion: string;
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
    e2eePubKey: "",
    e2eePairingSecret: "",
    e2eeCryptoVersion: 1,
    e2eePairingId: "",
    e2eePairingExpiresAt: "",
    e2eeDeviceId: "",
    bridgeVersion: BRIDGE_VERSION,
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

export function apply(ctx: any, _config: any = {}) {
  let state: PanelState = { ...defaultState(), ...loadPanelState() };

  let child: ReturnType<typeof spawn> | null = null;
  let stopped = false;
  let session: Session | null = loadSession();
  let grantSecret = ""; // 领取凭证：只存内存，绝不下地
  let pollTimer: ReturnType<typeof setInterval> | null = null;
  let lastConfig: PanelState | null = null;
  let lastRespawnAt = 0;
  let yieldRetries = 0; // 让位/被占用后的礼貌重试次数（成功启动即清零）
  // 新版 DSH（v0.1.5+）鉴权：connection 服务提供的进程 launch token（每次 DSH 启动换新）。
  // 桥子进程用它做一次性 Cookie 换发。老版 DSH 无 connection 服务 → token 保持空，
  // 桥按无鉴权模式直连（向后兼容）。
  let dshLaunchToken = "";
  let webServerPort = 3080;
  let tokenPollTimer: ReturnType<typeof setInterval> | null = null;

  function dshBaseUrl(): string {
    return process.env.DSHMOBILE_DSH_URL || `http://127.0.0.1:${webServerPort}`;
  }

  /** 宿主关键事件落盘（stdio 不可见时也能诊断）。 */
  function hostLog(msg: string) {
    try {
      mkdirSync(STATE_DIR, { recursive: true });
      appendFileSync(path.join(STATE_DIR, "host.log"), `${new Date().toISOString()} ${msg}\n`);
    } catch {
      /* 日志失败不影响主流程 */
    }
  }

  /** 从 connection 服务提取 launch token；成功返回 true。多渠道共用，保证不重不漏。 */
  function applyToken(connectionCtx: any, source: string): boolean {
    try {
      const port = connectionCtx?.webServer?.port;
      if (Number.isInteger(port) && port > 0) webServerPort = port;
      const conn = connectionCtx?.connection ?? connectionCtx?.get?.("connection");
      if (!conn || typeof conn.authenticatedUrl !== "function") {
        hostLog(`token[${source}]: connection service not visible`);
        return false;
      }
      const authed = conn.authenticatedUrl(dshBaseUrl());
      const token = new URL(authed).searchParams.get("token") ?? "";
      if (token && token !== dshLaunchToken) {
        dshLaunchToken = token;
        hostLog(`token[${source}]: acquired (bridge will authenticate /api)`);
        if (state.enabled && (session !== null || Boolean(state.username && state.password)) && child) {
          startBridge(state);
        }
      }
      return Boolean(token);
    } catch (err: any) {
      hostLog(`token[${source}]: failed: ${err?.message ?? err}`);
      return false;
    }
  }

  // 途径 1：同步直取（connection 服务可能已就绪）
  try {
    const conn = ctx?.get?.("connection") ?? ctx?.root?.get?.("connection");
    const ws = ctx?.get?.("webServer") ?? ctx?.root?.get?.("webServer");
    if (conn) applyToken({ connection: conn, webServer: ws }, "sync");
  } catch (err: any) {
    hostLog(`token[sync]: ${err?.message ?? err}`);
  }

  // 途径 2：事件驱动注入（官方形态；服务就绪后回调）
  try {
    ctx.inject?.(["connection"], (connectionCtx: any) => applyToken(connectionCtx, "inject"));
  } catch (err: any) {
    hostLog(`token[inject]: unavailable: ${err?.message ?? err}`);
  }

  // 途径 3：轮询兜底（inject 不触发/作用域隔离时也能拿到；拿到即停）
  tokenPollTimer = setInterval(() => {
    if (dshLaunchToken) {
      if (tokenPollTimer) { clearInterval(tokenPollTimer); tokenPollTimer = null; }
      return;
    }
    try {
      const conn = ctx?.get?.("connection") ?? ctx?.root?.get?.("connection");
      const ws = ctx?.get?.("webServer") ?? ctx?.root?.get?.("webServer");
      if (conn) applyToken({ connection: conn, webServer: ws }, "poll");
    } catch {
      /* 下一轮再试 */
    }
  }, 1000);

  // 手机授权登录的会话重启后不回填账号（panel.json 只存手填值）→ 面板需显示已登录账号与退出按钮
  if (!state.username && session?.username) {
    state = { ...state, username: session.username };
  }

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

  /**
   * 接管残留桥进程（上次 DSH 被强杀留下的孤儿、或另一个 DSH 实例起的桥）。
   * 为什么必须做：它们与本宿主共用同一份 config/设备标识，只要并存就会在 relay 侧互相顶替，
   * 手机端表现为"刷新不出会话"。
   * 扫描/判定逻辑与桥侧自愈共用 `bridge/scan.js`（命令行形如 `node … bridge/main.js` 才算桥）。
   */
  function takeoverStaleBridges() {
    if (process.platform !== "win32") return; // 目前用户全是 Windows；其它平台仅靠桥侧单例锁
    try {
      const { killed } = killOtherBridges({ stateDir: STATE_DIR, log: (m: string) => console.log(`[dshmobile] ${m}`) });
      if (killed.length) hostLog(`takeover: 已结束残留桥进程 ${killed.join(",")}`);
    } catch (err: any) {
      hostLog(`takeover: 扫描失败（已忽略）：${err?.message ?? err}`);
    }
  }

  function startBridge(value: PanelState, opts: { noYield?: boolean } = {}) {
    stopBridge();
    takeoverStaleBridges();
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
        dsh: {
          url: dshBaseUrl(),
          token: dshLaunchToken,
          workspaceRoot: path.join(STATE_DIR, "deliveries"),
        },
        stateDir: STATE_DIR,
      };
      writeFileSync(CONFIG_FILE, JSON.stringify(cfg, null, 2));
      // 桥日志落盘到 <stateDir>/bridge.log（stdio 不再丢弃，重启后可直接诊断）
      let logFd = -1;
      try {
        mkdirSync(STATE_DIR, { recursive: true });
        logFd = openSync(path.join(STATE_DIR, "bridge.log"), "a");
      } catch { /* 打不开日志则不落盘 */ }
      const spawnArgs = [BRIDGE_MAIN, BRIDGE_STATE_MARKER];
      // 礼貌重试（不让位）：对方还活着就安静退出，对方没了才接管 —— 避免两个宿主互相顶替
      if (opts.noYield) spawnArgs.push("--no-yield");
      const p = spawn(process.execPath, spawnArgs, {
        env: { ...process.env, DSHMOBILE_BRIDGE_CONFIG: CONFIG_FILE },
        // 第 4 位 "ipc"：给桥一条与宿主的通信通道，宿主消失时桥会收到 disconnect 并退出
        // （防"孤儿桥"：孤儿桥会与下次启动的桥共用设备标识，在 relay 侧互相顶替）。
        stdio: ["ignore", logFd >= 0 ? logFd : "ignore", logFd >= 0 ? logFd : "ignore", "ipc"],
      });
      if (logFd >= 0) { try { closeSync(logFd); } catch { /* 子进程已持有句柄 */ } }
      child = p;
      p.on("exit", (code) => {
        // child !== p → 已被新桥替换或主动停止，忽略该退出事件
        if (stopped || child !== p) return;
        // 子进程已死：**必须清空引用**，否则后续"配置变化触发重启"会以为桥还在（实测踩过：面板 save 无效）
        child = null;
        if (code === BRIDGE_EXIT_ANOTHER_INSTANCE || code === BRIDGE_EXIT_YIELDED) {
          // 桥侧单例锁判定"另一个桥实例在运行 / 本桥已让位"：先不抢（避免两个宿主互相顶替），
          // 但也不能永久放弃 —— 若赢的那个进程后来消失（实测：它的 DSH 被关掉），本机就没人服务了。
          // 因此延迟重试，且重试时带 --no-yield（只试着绑定，不再要求对方让位）：
          // 对方还在 → 继续安静等待；对方没了 → 自动接管。
          const why = code === BRIDGE_EXIT_YIELDED ? "已让位给另一个桥实例" : "另一个桥实例正在运行";
          // 前几次每分钟重试一次（对方刚起来/刚关闭都能及时收敛），之后转为每 10 分钟一次、长期兜底：
          // 既不会与活着的对方互踢，也不会在对方消失后让本机一直没桥服务。
          yieldRetries += 1;
          const delay = yieldRetries <= MAX_FAST_YIELD_RETRIES ? YIELD_RETRY_MS : SLOW_YIELD_RETRY_MS;
          hostLog(`bridge exited ${code}: ${why}（第 ${yieldRetries} 次礼貌重试将在 ${delay / 1000}s 后）`);
          patchState({ bridgeStatus: `${why}（${delay / 1000} 秒后自动重试）` });
          setTimeout(() => {
            if (stopped || !state.enabled) return;
            if (session === null && !(state.username && state.password)) return;
            startBridge(state, { noYield: true });
          }, delay);
          return;
        }
        // 异常退出则 3 秒后自动拉起（60 秒内最多一次，防崩溃循环）
        patchState({ bridgeStatus: `exited:${code}，3 秒后自动重启` });
        const now = Date.now();
        if (now - lastRespawnAt > 60_000) {
          lastRespawnAt = now;
          setTimeout(() => {
            if (!stopped && state.enabled && (session !== null || Boolean(state.username && state.password))) {
              startBridge(state);
            }
          }, 3000);
        } else {
          patchState({ bridgeStatus: `exited:${code}（60 秒内已重启过，停止自动拉起，等待配置变化）` });
        }
      });
      p.on("error", (err) => {
        patchState({ bridgeStatus: `error:${err.message}` });
      });
      // 真正起来了（能连上 DSH 也由桥自己再确认）：重置让位重试计数
      yieldRetries = 0;
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

  /** 确保长期身份密钥存在（bridge 也会读同一份），返回 pubkey(b64url)。
   *  注意：**文件存在但读不出来时不再重建**——宿主写这份文件会把 `pinnedPeer` 清空，
   *  等于静默销毁 E2EE 绑定（手机端会卡在 key-mismatch，用户必须手动取消加密）。
   *  交给桥按"先备份再重建"的规则处理，这里只返回空并告警。 */
  function ensureIdentityKey(): string {
    if (existsSync(DEVICE_KEY_FILE)) {
      try {
        const d = JSON.parse(readFileSync(DEVICE_KEY_FILE, "utf8"));
        if (d.pubKey && d.privKey && d.keyId) return d.pubKey;
        console.warn("[dshmobile] device-key.json 字段不完整：交由桥重建（宿主不覆盖，避免清掉 E2EE pin）");
      } catch (err: any) {
        console.warn("[dshmobile] device-key.json 读取失败：交由桥重建（宿主不覆盖）", err?.message ?? err);
      }
      return "";
    }
    const kp = generateIdentityKeypair();
    try {
      mkdirSync(STATE_DIR, { recursive: true });
      writeFileSync(DEVICE_KEY_FILE, JSON.stringify({ pubKey: kp.pubKey, privKey: kp.privKey, keyId: kp.keyId, pinnedPeer: null }, null, 2), { mode: 0o600 });
    } catch {}
    return kp.pubKey;
  }

  /** 读取桥回写的 deviceId（bridge provision 后写入 stateDir/device-id.json）。 */
  function readDeviceId(): string {
    try {
      const f = path.join(STATE_DIR, "device-id.json");
      if (!existsSync(f)) return "";
      const d = JSON.parse(readFileSync(f, "utf8"));
      return typeof d?.deviceId === "string" ? d.deviceId : "";
    } catch {
      return "";
    }
  }

  /**
   * 加密配对（第二个码，mode=e2ee）：独立于登录码。
   * 组成 = 桥公钥 pk + 一次性配对 secret + pairingId + deviceId；
   * secret 写入 pairing.json（键=pairingId）供 bridge 的 key.exchange 校验。
   */
  function ensureE2eeCode() {
    const deviceId = readDeviceId();
    if (!deviceId) {
      // 桥还没注册出 deviceId：E2EE 码暂不可用（面板显示"等待桥注册"）
      if (state.e2eeDeviceId) patchState({ e2eeDeviceId: "", e2eePairingId: "", e2eePairingExpiresAt: "" });
      return;
    }
    const hasValid =
      state.e2eeDeviceId === deviceId &&
      state.e2eePairingId &&
      state.e2eePairingSecret &&
      state.e2eePairingExpiresAt &&
      new Date(state.e2eePairingExpiresAt).getTime() > Date.now() + 30_000;
    if (hasValid) return;

    const pubKey = ensureIdentityKey();
    const pairingId = randomUUID();
    const secret = randomPairingSecret();
    const expiresAt = Date.now() + E2EE_PAIRING_TTL_MS;
    try {
      // 清理过期条目后写入新 secret（键=pairingId，不再是登录码）
      const existing = existsSync(PAIRING_FILE) ? JSON.parse(readFileSync(PAIRING_FILE, "utf8")) : {};
      const now = Date.now();
      for (const k of Object.keys(existing)) {
        if (Number(existing[k]?.expiresAt ?? 0) < now) delete existing[k];
      }
      existing[pairingId] = { secret, expiresAt };
      writeFileSync(PAIRING_FILE, JSON.stringify(existing, null, 2));
    } catch {}
    patchState({
      e2eePubKey: pubKey,
      e2eePairingSecret: secret,
      e2eeCryptoVersion: 1,
      e2eePairingId: pairingId,
      e2eePairingExpiresAt: new Date(expiresAt).toISOString(),
      e2eeDeviceId: deviceId,
    });
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
          // 会话已轮换：桥的 config.json 还是旧 token（已被吊销）——立即用新会话重启桥，
          // 否则下次桥断线重连 provision 会 401 死循环（宿主是会话唯一所有者）。
          if (child && state.enabled) startBridge(state);
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
      const msg = String(err?.message ?? err);
      // 会话刷新也失败（refresh token 已被吊销/过期）→ 清除死会话，避免每次启动重复 401 舞步
      if (session && /expired|invalid|Token/i.test(msg)) {
        session = null;
        try { rmSync(SESSION_FILE, { force: true }); } catch {}
      }
      patchState({
        pairError: `账号密码错误（${msg}），已切换为授权二维码：用手机 App 扫码即可授权本机登录`,
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
        ensureE2eeCode();
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
  hostLog(`plugin applied: dshUrl=${dshBaseUrl()} token=${dshLaunchToken ? "yes" : "no"}`);
  scheduleConfig(); // 首次装载：按持久化配置启动桥 + 出码

  return () => {
    stopped = true;
    stopPolling();
    stopBridge();
    if (tokenPollTimer) { clearInterval(tokenPollTimer); tokenPollTimer = null; }
    try { server.close(); } catch {}
  };
}
