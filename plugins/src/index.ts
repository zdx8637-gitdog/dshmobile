// @zdx8637/dshmobile-bridge · host 半边
// 更名记录：@liustack/dshmobile-bridge → @zdx8637/dshmobile-bridge（改用自有 scope 以便发布 npm 社区）
// 职责：
//   1. **常驻二维码**：与插件登录态无关，永远可扫——
//      · 有账号密码/会话 → mode=pair（手机扫码登录该账号，方向一）；
//      · 无任何凭据 → mode=grant（匿名出码 + 轮询，手机授权后本机登录，方向二）；
//   2. bridge 子进程守护：账号密码模式或手机授权 token 模式（包内 bridge 支持两种）；
//   3. 注册新账号。
// 数据通道（两条，运行时能力探测决定用哪条 —— 不看 DSH 版本号）：
//   ★ 首选：**官方连接服务** `ctx.connection.rpc` 的 RPC 通道 `"/dshmobile"`
//     （endpoint = state / action）。它是同源相对路径，由载体（桌面壳 / Host web 服务）转发并代持鉴权，
//     因此**不受页面 origin 影响** —— 官方桌面版 0.2.0 的窗口 origin 是自定义 scheme `dsh-app://app`，
//     旧的跨源 fetch 会被浏览器当作跨 scheme CORS 拦掉（`TypeError: Failed to fetch`），这条不会。
//   ☆ 兜底：1.0.x 起的 127.0.0.1 本地 HTTP（Web 面板 GET /state 轮询 + POST /action 下发动作）。
//     仅在**能力探测失败**时被面板使用（`typeof ctx.connection?.rpc?.handle === "function"` 为假，
//     例如更老/没有该服务的 DSH）；宿主这边**永远**照旧监听，两条通道可以同时存在。
// 收益：一条命令安装即用、跨平台、DSH 升级不受影响、无需任何本地补丁。
// ⚠ 1.0.7 起端口**绝不猜**：DSH 本机 API 的端口只从 `webServer.port` 读取（官方桌面 `--port 0` 随机端口、
//    `dsh web` 默认 3080 但可改、dsh-tauri 默认 3080 被占则顺延 —— 三种载体端口策略不同，猜必错）；
//    未解析前桥不启动（面板显示 dsh-port-unresolved），可用 DSHMOBILE_DSH_URL 显式指定。
import { spawn } from "node:child_process";
import { execSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { appendFileSync, closeSync, copyFileSync, existsSync, mkdirSync, openSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
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
// 桥自己发现"宿中心跳过期"而自杀的退出码（见 bridge/main.js hostWatchdog）：同样**不得**自动拉起。
const BRIDGE_EXIT_HOST_GONE = 44;
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
// E2EE 策略（与桥同一份文件）：{"require":bool}，缺失/坏文件 = 要求加密（与桥侧默认一致）
const E2EE_POLICY_FILE = path.join(STATE_DIR, "e2ee-policy.json");
const PAIRING_FILE = path.join(STATE_DIR, "pairing.json");
/* ==================== 宿主存活心跳（桥的兜底自杀条件） ====================
   背景（实测缺陷）：卸载/关闭插件后，桥可能继续在后台跑并继续连 relay —— 手机仍能操作这台电脑。
   `process.ppid` / IPC disconnect 都**发现不了**"DSH 进程还活着、只是插件被卸载了"这种情况，
   所以必须由宿主主动证明"我还活着"：
     · 宿主每 HEARTBEAT_WRITE_MS 写一次 `<stateDir>/host-alive.json`（含 pid + 时间戳）；
     · 卸载（dispose）时删掉它；
     · 桥每 HEARTBEAT_CHECK_MS 检查一次，超过 HEARTBEAT_STALE_MS 没更新（或文件不存在）⇒ 自杀退出。
   阈值故意宽松（宿主 5s 写一次，桥容忍 90s）：宁可不杀，也不要误杀一个正常工作的桥。
   ⚠ 顺序契约：**必须先创建心跳文件，再 spawn 桥**（apply() 里 writeHeartbeat() 早于 startServer()）。
   ⚠ 不做"文件从未出现过就不退出"的特例 —— 那会让这道保护在最需要它的场景下失效。 */
const HEARTBEAT_FILE = path.join(STATE_DIR, "host-alive.json");
const HEARTBEAT_WRITE_MS = 5_000;
const HEARTBEAT_STALE_MS = 90_000;
const HEARTBEAT_CHECK_MS = 5_000;
/** 桥配置里的字段名（桥侧读 config.hostHeartbeatFile / config.hostHeartbeatStaleMs）。 */
const HEARTBEAT_FIELD = "hostHeartbeatFile";
const HEARTBEAT_STALE_FIELD = "hostHeartbeatStaleMs";
// 兜底（**默认开启 = 启动即连**）：对标微信/淘宝 —— 正常启动 / DSH 重启 / 插件更新后都自动登录。
// 只有显式关掉（panel.json 里 `autoConnect:false`，或插件配置 `{autoConnect:false}`）才退化为
// 「必须用户点一次『保存并连接』」；用户点过连接（startedByUser）则始终允许。
const DEFAULT_AUTO_CONNECT = true;
// 兜底通道：本地 HTTP 服务端口（面板侧同值；可用环境变量改，仅影响兜底路径）。
const HTTP_PORT = parseInt(process.env.DSHMOBILE_HTTP_PORT ?? "17653", 10);
// 首选通道：官方连接服务上的 RPC 通道名。
// ⚠ 两条硬约束（官方 `assertChannel`，见 @deepseek-ai/dsh-client-connection）：
//   1) **必须带前导斜杠**（正则 `^\/[A-Za-z0-9._~-]+$`，写 "dshmobile" 会直接抛 invalid channel）；
//   2) 不能是保留名 `"/api"`（官方 API 网关占用）。
// 客户端调用时写同一个字符串（`rpc.call("/dshmobile", endpoint, payload)`，内部 slice(1) 成相对路径）。
const RPC_CHANNEL = "/dshmobile";
// 官方通道的探测节奏（秒）：前 60s 每秒试一次 → 之后每 30s 一次 → 300s 后放弃（转纯 HTTP 兜底）。
// 放弃后行为与 1.0.x 完全一致：拿到 launch token 就停掉轮询。
const RPC_PROBE_FAST_TICKS = 60;
const RPC_PROBE_SLOW_EVERY = 30;
const RPC_PROBE_GIVE_UP_TICKS = 300;
// 加密配对码（第二个码）TTL：独立于登录码，15 分钟足够完成「扫码→连设备→握手」。
const E2EE_PAIRING_TTL_MS = 900_000;

/* ==================== ④ 安装生命周期：凭据只活在「这次安装」里 ====================
   产品口径（对标微信/淘宝）：
     · 正常启动 / DSH 重启 / 插件更新（含同版本重装）⇒ **保持登录**（自动登录）；
     · 插件卸载 ⇒ 凭据必须消失；卸载后重装 ⇒ 空状态、必须重新登录。
   两条**互相独立**的判据（任一成立即清；都不成立则绝不动凭据）：

   判据 1（卸载当场，快）：插件的 disposer 被调用时读 `<profile>/package.json`
     · `dsh.profile.bundles` **仍含本包** ⇒ App 退出 / 配置热重载 ⇒ 直接返回，**绝不动凭据**；
     · 已不含本包 ⇒ 可能是真卸载、也可能只是「关掉开关」⇒ 落 tombstone，并每 1s（最多 30 次）
       检查「`dependencies` 里没有本包 **且** 包目录不存在」⇒ 两者都成立才清凭据（.unref()，不拖住进程退出）。
     依据（见 DSH-PLUGIN-UNINSTALL-LIFECYCLE.md §2.1/§4.1）：卸载 = 先摘 bundles → reload（dispose 插件 fiber）
     → 再 `pnpm remove`；更新（installBundle 走 restart-required 分支）**根本不 dispose**。

   判据 2（启动对账，准）：每次 apply 读 `<profile>/.plugin-manager/logs/operation-XXXXXX` 里的 pnpm.log
     · 每个 operation 目录 = DSH 的一次 pnpm 操作，日志里的 `+ 包名` = 安装、`- 包名` = 卸载；
     · 记账锚点（已对账过的 operation 目录名 + 最新 mtime）写在 `<stateDir>/install-ledger.json`，幂等可重复执行；
     · 「自上次记账以来」存在**只对本包**的 `- 记录` ⇒ 清凭据；
     · 同一个 operation 里同时出现 `+`/`-`（pnpm 换版本的差异输出）**不算**卸载凭据（更新必须保持登录）；
     · 找不到 logs 目录 ⇒ **必须写 host.log 留痕**（将来 DSH 若改掉该布局，这里是静默漏删的唯一线索），且不动凭据。

   判据 2b（首次回溯，堵漏档；1.0.6 新增）：判据 2 的锚点机制有个明确空档 —— **首次记账只落锚点、
   不回溯历史日志**。于是「上一个版本（没有清理钩子的旧版）卸载时留在磁盘上的凭据」会被新版本
   当成自己的，照单全收 ⇒ 用户实测：卸载 1.0.3 → 装 1.0.5 → **直接就是登录状态**（违背「卸载即重新登录」）。
   修法 = 启动时**回溯全部历史**日志做一次时间戳比对：
     · 卸载记录时间 = 所有「只含 `- 本包`」的 operation 里最新的那个的时间；
     · 凭据时间     = **登录态锚点**文件（`LOGIN_STATE_FILES` = session.json / device-key.json，
                      只挑"只在真的登录/建身份时才被写"的文件）里**最新**的 mtime；
     · 卸载记录**新于等于**凭据 ⇒ 这些凭据属于上一次安装 ⇒ 清掉 ⇒ 本次运行为未登录、要求重新登录；
     · 有任何一个登录态锚点**新于**卸载记录 ⇒ 卸载后已经重新登录过 ⇒ **保持登录**（不误登出老用户）。
   ⚠ 时间戳方向是关键：只有「卸载记录比凭据新」才清，"很久以前卸载过、之后又正常登录"的老用户不受影响。
   ⚠ 这条与判据 2 的锚点机制互不干扰：2b 在锚点之外**额外**跑一次全量回溯，命中即清并推进锚点后返回；
     2b 不命中则完全走原来的锚点路径（"启动时新发现的卸载回执"仍由锚点负责）。

   明确**不删**：诊断日志（bridge.log / host.log / e2ee-debug.log）、用户偏好（e2ee-policy.json）、
   记账文件（install-ledger.json，不是凭据而是墓碑/锚点）、用户数据（deliveries/）、
   运行期临时文件（bridge.lock.json / takeover-scan.ps1）。理由逐条写在报告里。 */
const PACKAGE_NAME = "@zdx8637/dshmobile-bridge";
const LEDGER_FILE = path.join(STATE_DIR, "install-ledger.json");
// 卸载确认轮询：1s × 30（本机 3 次真实 pnpm remove 分别耗时 310/291/319ms，30s 极宽裕）。
// 环境变量只作**离线自测**用的加速开关（生产不设即用默认值）。
const UNINSTALL_POLL_MS = parseInt(process.env.DSHMOBILE_UNINSTALL_POLL_MS ?? "1000", 10);
const UNINSTALL_POLL_TRIES = parseInt(process.env.DSHMOBILE_UNINSTALL_POLL_TRIES ?? "30", 10);
/** 记账锚点最多保留多少个 operation 名字（logs 目录只增不减，锚点不能无限膨胀）。 */
const LEDGER_MAX_OPS = 200;
/** 「清除本机凭据」要删的文件清单（只列**凭据/身份**，不含日志与偏好）。
 *  ⚠ 必须包含设备私钥与设备身份：只删 token 的话，重装后 relay 侧仍认得这台设备。 */
const CREDENTIAL_FILES = [
  "session.json",          // relay access + refresh token（登录态本体）
  "config.json",           // 桥的配置：同一组 token + clientDeviceKey（凭据容器；桥每次启动都会重写）
  "panel.json",            // 面板持久化：预填账号（身份痕迹）+ 连接偏好 ⇒ 卸载后必须回到空状态
  "device-id.json",        // relay 侧设备身份（provision 得到，手机端设备列表就是它）
  "device-key.json",       // E2EE 设备身份私钥（+ pinnedPeer 绑定）—— 设备私钥，必须删
  "dsh-auth-cookie.json",  // 本机 DSH API 的会话 Cookie 缓存（launch token 换来的）
  "pairing.json",          // 一次性配对 secret（15min TTL，但属配对凭据）
  "machine-key.txt",       // 无 MachineGuid 时的机器标识（relay clientDeviceKey 的来源）
];

/** 状态目录里的关键事件落盘（模块级：判据 1/2 在 apply 之外也要能写）。 */
function stateLog(msg: string) {
  try {
    mkdirSync(STATE_DIR, { recursive: true });
    appendFileSync(path.join(STATE_DIR, "host.log"), `${new Date().toISOString()} ${msg}\n`);
  } catch {
    /* 日志失败不影响主流程 */
  }
}

function readJsonFile(file: string): any | null {
  try {
    return JSON.parse(readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}

/* ---- install-ledger.json：判据 2 的记账锚点 + 判据 1 的 tombstone ---- */
interface InstallLedger {
  version: number;
  /** 已对账过的 operation 目录名（新的在前，最多 LEDGER_MAX_OPS 个）—— 幂等的关键。 */
  processed: string[];
  /** 已处理过的 pnpm.log 最大 mtime（processed 被截断后的兜底闸门）。 */
  lastOpMtimeMs: number;
  /** 「可能被卸载」的足迹：dispose 时 bundles 已不含本包 ⇒ 记在这里，供下次启动对账。 */
  pendingUninstall: { at: number; reason: string } | null;
  /** 最后一次清除凭据的时间 / 原因 / 删掉的文件（诊断用）。 */
  lastWipe: { at: number; reason: string; files: string[] } | null;
  updatedAt: string;
}

function loadLedger(): InstallLedger {
  const raw = readJsonFile(LEDGER_FILE);
  const pending = raw?.pendingUninstall;
  const lastWipe = raw?.lastWipe;
  return {
    version: 1,
    processed: Array.isArray(raw?.processed) ? raw.processed.filter((n: unknown) => typeof n === "string") : [],
    lastOpMtimeMs: Number.isFinite(raw?.lastOpMtimeMs) ? Number(raw.lastOpMtimeMs) : 0,
    pendingUninstall:
      pending && typeof pending === "object"
        ? { at: Number(pending.at) || 0, reason: String(pending.reason ?? "") }
        : null,
    lastWipe:
      lastWipe && typeof lastWipe === "object"
        ? {
            at: Number(lastWipe.at) || 0,
            reason: String(lastWipe.reason ?? ""),
            files: Array.isArray(lastWipe.files) ? lastWipe.files.filter((f: unknown) => typeof f === "string") : [],
          }
        : null,
    updatedAt: typeof raw?.updatedAt === "string" ? raw.updatedAt : "",
  };
}

/** 原子写记账文件（tmp + rename）：崩溃时不会留下半个 JSON。 */
function saveLedger(l: InstallLedger) {
  try {
    mkdirSync(STATE_DIR, { recursive: true });
    l.updatedAt = new Date().toISOString();
    const tmp = `${LEDGER_FILE}.tmp-${process.pid}`;
    writeFileSync(tmp, JSON.stringify(l, null, 2));
    renameSync(tmp, LEDGER_FILE);
  } catch (err: any) {
    stateLog(`install-ledger: 写入失败（不影响本次判定，但下次可能重复对账）：${err?.message ?? err}`);
  }
}

function updateLedger(mutate: (l: InstallLedger) => void): InstallLedger {
  const l = loadLedger();
  try {
    mutate(l);
  } catch (err: any) {
    stateLog(`install-ledger: 更新异常（已忽略）：${err?.message ?? err}`);
  }
  saveLedger(l);
  return l;
}

/* ---- profile 目录与「本包是否还在这次安装里」---- */

/** profile 目录：`ctx.get("profileContext").dir` 首选；取不到则从本包目录向上找带
 *  `dsh.profile.bundles` 的 package.json（不依赖任何 DSH 内部结构，两者都失败则返回 null）。 */
function resolveProfileDir(ctx: any): string | null {
  const fromEnv = process.env.DSHMOBILE_PROFILE_DIR;
  if (fromEnv && existsSync(path.join(fromEnv, "package.json"))) return fromEnv;
  try {
    const pc = ctx?.get?.("profileContext") ?? ctx?.root?.get?.("profileContext");
    const dir = pc?.dir;
    if (typeof dir === "string" && dir && existsSync(path.join(dir, "package.json"))) return dir;
  } catch {
    /* 老版本 DSH 没有 profileContext：走下面的兜底 */
  }
  let d = path.resolve(HERE, "..");
  for (let i = 0; i < 6; i++) {
    const m = readJsonFile(path.join(d, "package.json"));
    if (Array.isArray(m?.dsh?.profile?.bundles)) return d;
    const up = path.dirname(d);
    if (up === d) break;
    d = up;
  }
  return null;
}

/** `<profile>/package.json` 的 `dsh.profile.bundles` 里还有本包吗？
 *  ⚠ null = 读不到 / 结构不明 ⇒ 判据不成立（fail-safe：宁可留凭据，也不误删登录态）。 */
function bundlesHasPackage(profileDir: string): boolean | null {
  const m = readJsonFile(path.join(profileDir, "package.json"));
  const list = m?.dsh?.profile?.bundles;
  if (!Array.isArray(list)) return null;
  return list.includes(PACKAGE_NAME);
}

/** `dependencies` 里还有本包吗？null = 读不到。 */
function dependenciesHasPackage(profileDir: string): boolean | null {
  const m = readJsonFile(path.join(profileDir, "package.json"));
  const deps = m?.dependencies;
  if (!deps || typeof deps !== "object") return null;
  return Object.prototype.hasOwnProperty.call(deps, PACKAGE_NAME);
}

/** `<profile>/node_modules/@scope/name`（hoisted linker 下就是真实包目录；isolated 下也仍是同一个入口路径）。 */
function packageDir(profileDir: string): string {
  return path.join(profileDir, "node_modules", ...PACKAGE_NAME.split("/"));
}

function packageDirExists(profileDir: string): boolean {
  try {
    return existsSync(packageDir(profileDir));
  } catch {
    return false;
  }
}

/** 真卸载确认：bundles 不含本包 **且** dependencies 不含本包 **且** 包目录已消失。
 *  「只是关掉开关」只满足第一条（依赖与目录都还在）⇒ 不确认 ⇒ 不误删。 */
function uninstallConfirmed(profileDir: string): boolean {
  return (
    bundlesHasPackage(profileDir) === false &&
    dependenciesHasPackage(profileDir) === false &&
    !packageDirExists(profileDir)
  );
}

/* ---- pnpm 操作流水账（判据 2 的输入）---- */
interface OpDir {
  name: string;
  log: string;
  mtimeMs: number;
}

/** 列出 `<profile>/.plugin-manager/logs/operation-*`，按 mtime 升序（目录名是随机串，无内在顺序）。
 *  ⚠ null = 日志根目录读不到 ⇒ 判据 2 本次无输入（必须留痕，见 reconcileInstallLedger）。 */
function listOperationDirs(profileDir: string): OpDir[] | null {
  const root = path.join(profileDir, ".plugin-manager", "logs");
  try {
    if (!existsSync(root)) return null;
    const out: OpDir[] = [];
    for (const e of readdirSync(root, { withFileTypes: true })) {
      if (!e.isDirectory() || !e.name.startsWith("operation-")) continue;
      const dir = path.join(root, e.name);
      const log = path.join(dir, "pnpm.log");
      let mtimeMs = 0;
      try {
        mtimeMs = statSync(log).mtimeMs;
      } catch {
        try {
          mtimeMs = statSync(dir).mtimeMs;
        } catch {
          mtimeMs = 0;
        }
      }
      out.push({ name: e.name, log, mtimeMs });
    }
    out.sort((a, b) => a.mtimeMs - b.mtimeMs || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    return out;
  } catch {
    return null;
  }
}

/** 一个 operation 日志里本包的标记：`{'+'}` / `{'-'}` / `{'-','retro'}`（同时含 +/- 的"换版本差异输出"）
 *  / `{'+','-'}`；null = 该操作与本包无关。
 *  只匹配 ASCII 行首标记 `^[+-]\s+<包名>`（pnpm 的框线字符是多字节 UTF-8，不要去碰）。
 *  ⚠ 1.0.6 起额外区分两种 `-`：
 *    · 一个操作里**只出现** `- 本包` ⇒ 标记 `'-'` = 真卸载记录（判据 2 / 2b 的依据）；
 *    · 同一个操作里 `- 本包` 与 `+ 本包` **同时**出现 ⇒ 只有 `retro`（pnpm 换版本的差异输出）
 *      ⇒ 既不算卸载（更新必须保持登录），也**不能**被判据 2b 当成"上一次安装的卸载记录"。 */
function packageMarkers(logFile: string): Set<string> | null {
  let text = "";
  try {
    text = readFileSync(logFile, "utf8");
  } catch {
    return null;
  }
  const escaped = PACKAGE_NAME.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const re = new RegExp(`^([+-])[ \\t]+${escaped}(?![\\w.@/-])`, "gm");
  const set = new Set<string>();
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) set.add(m[1]);
  if (!set.size) return null;
  if (set.has("-")) {
    if (set.has("+")) {
      // 同一操作里既有 - 又有 +：pnpm 换版本的差异输出 ⇒ 不是卸载记录
      return new Set<string>(["retro"]);
    }
    return new Set<string>(["-"]);
  }
  return new Set<string>(["+"]); // 纯安装记录
}

/** 清除本机凭据（清单 = CREDENTIAL_FILES）。幂等：文件不存在也算成功。 */
function wipeLocalCredentials(reason: string): { deleted: string[]; failed: string[] } {
  const deleted: string[] = [];
  const failed: string[] = [];
  for (const n of CREDENTIAL_FILES) {
    const f = path.join(STATE_DIR, n);
    try {
      if (!existsSync(f)) continue;
      rmSync(f, { force: true });
      deleted.push(n);
    } catch {
      failed.push(n);
    }
  }
  stateLog(
    `wipe: ${reason} → 已删除 [${deleted.join(", ") || "无"}]` +
      (failed.length ? `；删除失败 [${failed.join(", ")}]` : "") +
      `（保留：诊断日志 / e2ee-policy.json / install-ledger.json / deliveries）`,
  );
  updateLedger((l) => {
    l.pendingUninstall = null;
    l.lastWipe = { at: Date.now(), reason, files: deleted };
  });
  return { deleted, failed };
}

/** `<stateDir>/session.json` 是否比 `ms` 更新（= 那次卸载记录之后又登录过）。
 *  用于避免"已结清的卸载记录"在下次启动时误删**新登录**态。 */
function sessionNewerThan(ms: number): boolean {
  try {
    return statSync(path.join(STATE_DIR, "session.json")).mtimeMs > ms;
  } catch {
    return false;
  }
}

/* ---- 判据 2b：首次回溯（时间戳比对）---- */

/** operation 目录名里的创建时间（`operation-<base36 毫秒>`，取自 DSH 的 `mkdtemp(join(logRoot,'operation-'))`）。
 *  null = 名字不是这种形态（老版本 / 测试造的名）⇒ 用文件 mtime。 */
function opNameTimeMs(name: string): number | null {
  const m = /^operation-([0-9a-z]+)$/.exec(name);
  if (!m) return null;
  const ms = parseInt(m[1], 36);
  if (!Number.isFinite(ms) || ms <= 0) return null;
  // 合理区间（2001-09-09 ~ 5138 年）——排除误把随机串解析成数字
  if (ms < 1e12 || ms > 1e14) return null;
  return ms;
}

/** 一次操作的时间（判据 2b 的时间轴）。
 *  ⚠ 目录名里的时间**就是** mkdtemp 的创建时刻 ⇒ 比 mtime 更权威：取两者较大值。
 *    这同时兜住"文件系统 mtime 被整体重置/回拨"的机器（否则老的卸载记录会显得比凭据还新）。 */
function opTimeMs(o: OpDir): number {
  const fromName = opNameTimeMs(o.name);
  return fromName === null ? o.mtimeMs : Math.max(o.mtimeMs, fromName);
}

/** 「登录态锚点」：这些文件的 mtime 代表**这次安装**最后一次真的动过登录态的时刻。
 *  ⚠ 只用这两个（**故意不含 config.json / device-id.json**，理由都有本机实证）：
 *    · `session.json` —— **只在登录成功时写**（设备码登录 index.ts 的 saveSession() 三处调用点），
 *      是"这次安装有没有真的登录过"的唯一直接证据；
 *    · `device-key.json` —— E2EE 设备身份：不存在时生成、pin 变化时重写；旧版卸载留下的私钥
 *      被清掉后会重新生成 ⇒ 它的 mtime 同样是"本机登录后写过凭据"的证据。
 *  为什么不把 config.json / device-id.json 算进来（**实测**：本机 2026-10-01 卸载 1.0.3 于 15:50:45，
 *  随后 1.0.5 一启动就把 config.json 重写成 15:57:53、device-id.json 重写成 15:57:54，而**并没有重新登录**
 *  —— 用户就是这个状态）：
 *    · `config.json` 由宿主/桥在**每次启动**时重写（与是否登录无关）；
 *    · `device-id.json` 由桥在**每次 provision**（首次拿到设备令牌）时写。
 *  把这两个算成"登录态锚点"，就会让"上一个版本留下的凭据"看起来是本次安装写的
 *  ⇒ 判据 2b 永不触发 ⇒ **修的正是本次要修的漏档，等于没修**。 */
const LOGIN_STATE_FILES = ["session.json", "device-key.json"];

/** 登录态锚点里最新的 mtime；null = 一个都不存在。 */
function loginStateMtimeMs(): number | null {
  let newest: number | null = null;
  for (const n of LOGIN_STATE_FILES) {
    try {
      const ms = statSync(path.join(STATE_DIR, n)).mtimeMs;
      if (newest === null || ms > newest) newest = ms;
    } catch {
      /* 该锚点不存在 ⇒ 跳过 */
    }
  }
  return newest;
}

/** 磁盘上还剩几个凭据文件（`CREDENTIAL_FILES` 清单）——判据 2b 用它兜住"没东西可清"的情况：
 *  凭据一个都不在 ⇒ 本次运行为本来就是未登录 ⇒ **不写 wipe、不重复告警**（幂等）。 */
function credentialFileCount(): number {
  let n = 0;
  for (const f of CREDENTIAL_FILES) {
    try {
      if (existsSync(path.join(STATE_DIR, f))) n += 1;
    } catch {
      /* 读不到 ⇒ 不计入 */
    }
  }
  return n;
}

/** 判据 2b：回溯全部历史卸载记录，回答"磁盘上的凭据是不是上一次安装留下的"。
 *  @param ops `listOperationDirs()` 的结果（null = logs 读不到 ⇒ 调用方已留痕，这里按"无记录"处理）。
 *  · `"none"`   = 历史里没有本包的卸载记录（正常启动 / 只更新过）⇒ 凭据属于本次安装；
 *  · `"empty"`  = 有卸载记录，但磁盘上**一个凭据都没有** ⇒ 本来就是未登录，无需清（幂等关键）；
 *  · `"settled"`= 有卸载记录，但有登录态锚点比它新（卸载后重新登录过）⇒ 保持登录；
 *  · `"stale"`  = 有卸载记录，且所有登录态锚点都比它旧 ⇒ 凭据是上一次安装的遗留 ⇒ 清。
 *  边界（`credMs >= atMs` 判为"已重新登录"）：两者**同一时刻**算"卸载后又登录过"⇒ **保持登录**。
 *  理由：凭据的 mtime 是"最后一次真的写登录态"的时刻，它 **== 卸载记录时刻**只可能出现在
 *  「卸载后极短时间内就登录」（毫秒级打平，不可区分）这一种情形 ⇒ 按 fail-safe 方向（宁可留凭据、
 *  也不误登出用户）处理；真正"上一个版本留下的"凭据通常比卸载记录早几分钟到几天，不受影响。 */
function checkStaleCredentials(ops: OpDir[] | null): {
  verdict: "none" | "empty" | "settled" | "stale";
  newest: OpDir | null;
  atMs: number;
  credMs: number | null;
  files: number;
} {
  const credMs = loginStateMtimeMs();
  const files = credentialFileCount();
  const removals: { op: OpDir; atMs: number }[] = [];
  for (const o of ops ?? []) {
    const markers = packageMarkers(o.log);
    // 只认「只含 `- 本包`」的操作；同一操作里同时含 +/- ⇒ 标记 retro ⇒ 不算卸载记录
    if (markers?.has("-")) removals.push({ op: o, atMs: opTimeMs(o) });
  }
  if (!removals.length) return { verdict: "none", newest: null, atMs: 0, credMs, files };
  const newest = removals.reduce((a, b) => (b.atMs > a.atMs ? b : a));
  const base = { newest: newest.op, atMs: newest.atMs, credMs, files };
  if (files === 0) return { verdict: "empty", ...base };
  if (credMs !== null && credMs >= newest.atMs) return { verdict: "settled", ...base };
  return { verdict: "stale", ...base };
}

/* ---- 判据 1：卸载当场 ---- */
/** dispose 时调用：判断这次 dispose 是「真卸载」还是「App 退出 / 热重载 / 关开关」。 */
function onPluginDisposed(profileDir: string | null, reason: string) {
  if (!profileDir) {
    stateLog(`uninstall-watch: 取不到 profile 目录（无 profileContext 且向上没找到 dsh.profile.bundles）⇒ 判据 1 跳过、凭据不动（fail-safe）`);
    return;
  }
  const listed = bundlesHasPackage(profileDir);
  if (listed === null) {
    stateLog(`uninstall-watch: 读不出 ${path.join(profileDir, "package.json")} 的 dsh.profile.bundles ⇒ 凭据不动（fail-safe）`);
    return;
  }
  if (listed) {
    stateLog(`dispose: ${reason} → bundles 里仍有本包（App 退出 / 配置热重载）⇒ 凭据不动`);
    return;
  }
  // bundles 已摘除：可能是「真卸载」，也可能只是「关掉开关」⇒ 落 tombstone + 轮询确认
  updateLedger((l) => {
    l.pendingUninstall = { at: Date.now(), reason };
  });
  stateLog(`uninstall-watch: bundles 已摘除（${reason}）⇒ 落 tombstone，开始 1s×${UNINSTALL_POLL_TRIES} 轮询确认`);
  let tries = 0;
  const timer = setInterval(() => {
    tries += 1;
    try {
      if (uninstallConfirmed(profileDir)) {
        clearInterval(timer);
        const r = wipeLocalCredentials(`卸载确认（bundles/dependencies/包目录均已消失；第 ${tries} 次轮询）`);
        stateLog(`uninstall-watch: 确认真卸载 ⇒ 凭据已清除（删掉 ${r.deleted.length} 个文件）`);
        return;
      }
      if (tries >= UNINSTALL_POLL_TRIES) {
        clearInterval(timer);
        stateLog(
          `uninstall-watch: ${UNINSTALL_POLL_TRIES}s 内未确认（bundles=${bundlesHasPackage(profileDir)} ` +
            `deps=${dependenciesHasPackage(profileDir)} 包目录=${packageDirExists(profileDir)}）` +
            `⇒ 判定为「只是关掉开关 / 半途失败」，凭据保留；tombstone 留给下次启动对账`,
        );
      }
    } catch (err: any) {
      stateLog(`uninstall-watch: 轮询异常（忽略，继续）：${err?.message ?? err}`);
    }
  }, UNINSTALL_POLL_MS);
  timer.unref?.();
}

/* ---- 判据 2：启动对账 ---- */
/** 启动时对账：读 pnpm 流水账，先做判据 2b（全量回溯 + 时间戳比对），再按锚点处理增量。
 *  幂等：处理过的 operation 目录名写进 ledger；再跑一次没有新输入 ⇒ 什么都不做。 */
function reconcileInstallLedger(profileDir: string | null): { wiped: boolean; reason: string } {
  if (!profileDir) {
    stateLog("install-ledger: 取不到 profile 目录 ⇒ 判据 2（启动对账）跳过、凭据不动（fail-safe）");
    return { wiped: false, reason: "no-profile" };
  }
  const ledger = loadLedger();
  const ops = listOperationDirs(profileDir);
  if (ops === null) {
    // 报告 §7.3：这个目录若将来被 DSH 改掉/清掉，判据 2 会**静默漏删** ⇒ 必须留痕
    stateLog(
      `install-ledger: 找不到 ${path.join(profileDir, ".plugin-manager", "logs")} ⇒ 判据 2 本次跳过（凭据不动）。` +
        `⚠ 若 DSH 改掉了该目录布局，这里就是「卸载后凭据没被清」的唯一线索`,
    );
    return { wiped: false, reason: "no-logs" };
  }
  // 「首次记账」= 本机还没有任何记账文件（1.0.4 → 1.0.5 升级后的第一次运行，或全新 stateDir）。
  // ⚠ 判据故意用 updatedAt（"记账文件是否存在"）而不是 processed 是否为空：
  //   若首次运行时 logs 目录恰好是空的（例如开发态手工安装），记账文件照样会被写出来，
  //   之后出现的卸载回执才会被正常识别（否则会永远停在"首次记账"而漏删）。
  const firstTime = !ledger.updatedAt;

  // ── 判据 2b（1.0.6）：**回溯全部历史日志**，先堵掉"首次记账不回溯"的漏档 ──────────────
  //    场景：旧版（没有清理钩子）卸载 ⇒ 凭据留在磁盘上 ⇒ 装新版 ⇒ 新版把旧凭据当成自己的
  //          ⇒ 直接就是登录状态（用户实测复现）。这里在锚点之外额外做一次时间戳比对。
  const stale = checkStaleCredentials(ops);
  if (stale.verdict === "stale") {
    const r = wipeLocalCredentials(
      `首次回溯：卸载记录 ${stale.newest?.name}（${new Date(stale.atMs).toISOString()}）晚于本机凭据` +
        `（${stale.credMs === null ? "凭据不存在" : new Date(stale.credMs).toISOString()}）` +
        `⇒ 判定为上一次安装的遗留 ⇒ 清除，本次运行为未登录、需要重新登录`,
    );
    stateLog(
      `install-ledger: 判据 2b 首次回溯 ⇒ 发现**新于凭据**的卸载记录 ${stale.newest?.name}` +
        `（卸载 ${new Date(stale.atMs).toISOString()} / 凭据 ${stale.credMs === null ? "(不存在)" : new Date(stale.credMs).toISOString()}）` +
        `⇒ 凭据已清除（删掉 ${r.deleted.length} 个文件）`,
    );
    // ⚠ 必须用 updateLedger（在那个时刻**重新读盘**再改）：wipeLocalCredentials 刚刚写过 lastWipe，
    //   若用 `saveLedger({...启动时读到的 ledger})` 会把 lastWipe 又覆盖回 null（记账信息丢失）。
    updateLedger((l) => {
      l.processed = Array.from(new Set([...ops.map((o) => o.name).reverse(), ...l.processed])).slice(0, LEDGER_MAX_OPS);
      l.lastOpMtimeMs = Math.max(l.lastOpMtimeMs, ops.length ? ops[ops.length - 1].mtimeMs : 0);
      l.pendingUninstall = null; // 凭据已清 ⇒ 旧 tombstone 无意义（避免下次启动重复告警）
    });
    return { wiped: true, reason: "stale-credentials" };
  }
  if (stale.verdict === "settled") {
    stateLog(
      `install-ledger: 判据 2b 首次回溯 ⇒ 历史卸载记录 ${stale.newest?.name}` +
        `（${new Date(stale.atMs).toISOString()}）**早于**本机凭据` +
        `（${stale.credMs === null ? "(不存在)" : new Date(stale.credMs).toISOString()}）` +
        `⇒ 卸载之后已重新登录，凭据属于本次安装 ⇒ 保持登录`,
    );
  } else if (stale.verdict === "empty") {
    // 幂等：旧凭据清掉之后每次启动都会走到这里（磁盘上已无凭据）⇒ 不再写 wipe、不再重复告警
    stateLog(
      `install-ledger: 判据 2b 首次回溯 ⇒ 历史卸载记录 ${stale.newest?.name}，但磁盘上没有任何凭据文件` +
        `（本来就是未登录）⇒ 无需清除`,
    );
  }

  const seen = new Set(ledger.processed);
  const candidates = firstTime ? [] : ops.filter((o) => !seen.has(o.name) && o.mtimeMs > ledger.lastOpMtimeMs);
  const removals: OpDir[] = [];
  const ambiguous: string[] = [];
  for (const o of candidates) {
    const markers = packageMarkers(o.log);
    if (!markers) continue;
    if (markers.has("retro")) ambiguous.push(o.name);
    else if (markers.has("-")) removals.push(o);
  }
  let wiped = false;
  let reason = "nothing";
  if (firstTime) {
    // 首次记账（1.0.4 → 1.0.5 升级后的第一次运行，或全新 stateDir）：这里只落锚点、不回溯。
    // 理由：本判据靠"自上次记账以来"的增量，没有锚点时它无法区分历史与本次。
    // ⚠ 1.0.6 起"首次回溯"这个职责**已经交给判据 2b**（它靠时间戳方向判断，见上方注释与本文件
    //   开头的说明）⇒ 首次运行不再漏掉"上一个版本卸载时留下的凭据"。
    reason = "first-run";
    stateLog(
      `install-ledger: 首次记账（无历史锚点）⇒ 以当前最新操作 ${ops.length ? ops[ops.length - 1].name : "(无)"} 为锚点，不回溯清理`,
    );
  } else if (removals.length) {
    const newest = removals.reduce((a, b) => (b.mtimeMs > a.mtimeMs ? b : a));
    if (sessionNewerThan(newest.mtimeMs)) {
      reason = "settled";
      stateLog(
        `install-ledger: 发现卸载记录 ${removals.map((o) => o.name).join(", ")}，但 session.json 比其中最新的还新` +
          `（说明之后已重新登录）⇒ 视为已结清，凭据保留`,
      );
    } else {
      const r = wipeLocalCredentials(
        `启动对账：发现卸载记录 ${removals.map((o) => o.name).join(", ")}` +
          (ledger.pendingUninstall ? "（且有上次 dispose 落下的 tombstone）" : ""),
      );
      wiped = true;
      reason = "removal-receipt";
      stateLog(`install-ledger: 确认真卸载 ⇒ 凭据已清除（删掉 ${r.deleted.length} 个文件）`);
    }
  } else if (ledger.pendingUninstall) {
    reason = "tombstone-unconfirmed";
    stateLog(
      `install-ledger: 上次 dispose 落了 tombstone（${new Date(ledger.pendingUninstall.at).toISOString()}，` +
        `${ledger.pendingUninstall.reason}），但流水账里没有本包的卸载回执 ⇒ 判定为「App 退出 / 关开关 / 半途失败」，凭据保留`,
    );
  }
  if (ambiguous.length) {
    stateLog(
      `install-ledger: ${ambiguous.join(", ")} 同时含 +/- 记录（pnpm 换版本的差异输出）⇒ 不算卸载凭据（更新必须保持登录）`,
    );
  }
  // 推进锚点：所有看到的 operation 都记为已对账（幂等的关键）
  const names = ops.map((o) => o.name).reverse();
  const newestMtime = ops.length ? ops[ops.length - 1].mtimeMs : 0;
  updateLedger((l) => {
    l.processed = Array.from(new Set([...names, ...ledger.processed])).slice(0, LEDGER_MAX_OPS);
    l.lastOpMtimeMs = Math.max(ledger.lastOpMtimeMs, newestMtime);
    l.pendingUninstall = null; // 已对账过（无论结论如何）——避免每次启动重复告警
  });
  return { wiped, reason };
}

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
  /** 是否随宿主启动自动连桥（**默认 true = 启动即自动登录**；显式 false 才需要用户点「保存并连接」）。 */
  autoConnect: boolean;
  /** 宿主**自己**推导的"本机已登录"（会话在手上，或用户本次填了密码）——
   *  与"用户名非空"区分开：用户名只是预填值，不代表可用凭据。 */
  loggedIn: boolean;
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
    autoConnect: DEFAULT_AUTO_CONNECT,
    loggedIn: false,
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

/** 面板配置持久化（仅用户可编辑字段；二维码/状态等运行时字段不落盘）。
 *  ⚠ 1.0.4 起 **不再持久化 password**（明文口令不落盘）：panel.json 里即使有也会在启动时被清除。
 *  密码只活在内存里（本次进程），用于"换一次令牌"；令牌存 session.json。 */
function loadPanelState(): Partial<PanelState> {
  try {
    if (!existsSync(PANEL_FILE)) return {};
    const v = JSON.parse(readFileSync(PANEL_FILE, "utf8"));
    const out: Record<string, unknown> = {};
    for (const k of ["enabled", "relayUrl", "username", "deviceLabel", "autoConnect"]) {
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
        deviceLabel: s.deviceLabel,
        autoConnect: s.autoConnect,
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

/* ==================== ① 宿主存活心跳：写 / 清 ====================
   桥侧的兜底自杀条件（见 bridge/main.js 的 hostWatchdog）。宿主只负责"证明我还活着"：
   周期性写一个带时间戳的文件，卸载时删掉它 —— 桥据此判断宿主是否还在。 */

/** 立即写一次心跳（apply() 启动时第一件事，**必须在 spawn 桥之前**）。 */
function writeHeartbeat(): void {
  try {
    mkdirSync(STATE_DIR, { recursive: true });
    const body = JSON.stringify({ pid: process.pid, at: Date.now(), atIso: new Date().toISOString(), plugin: name });
    // 原子写：桥读到的永远是完整 JSON（先写临时文件再 rename）
    const tmp = `${HEARTBEAT_FILE}.tmp-${process.pid}`;
    writeFileSync(tmp, body);
    renameSync(tmp, HEARTBEAT_FILE);
  } catch {
    /* 心跳写失败不阻塞主流程：桥侧超时后会自行退出（宁可不杀，也不要因此让宿主起不来） */
  }
}

/** 删掉心跳文件（卸载路径）。桥看到"文件消失"会立刻自杀，不用等阈值。 */
function clearHeartbeat(): void {
  try { rmSync(HEARTBEAT_FILE, { force: true }); } catch { /* 忽略 */ }
}

/**
 * ② 老配置自动清理：删掉 config.json / panel.json 里的**明文口令**字段（只删这一个字段）。
 * @returns 被清理的文件名（用于 host.log 一行说明）
 */
function purgeLegacyPlaintextPassword(): string[] {
  const purged: string[] = [];
  for (const file of [CONFIG_FILE, PANEL_FILE]) {
    try {
      if (!existsSync(file)) continue;
      const raw = JSON.parse(readFileSync(file, "utf8"));
      if (!raw || typeof raw !== "object") continue;
      let hit = false;
      if (typeof (raw as any).password === "string" && (raw as any).password !== "") {
        delete (raw as any).password;
        hit = true;
      }
      // 桥的 config.json 是嵌套结构：口令在 relay.password（老版本由本宿主写入）
      const relay = (raw as any).relay;
      if (relay && typeof relay === "object" && typeof relay.password === "string" && relay.password !== "") {
        delete relay.password;
        hit = true;
      }
      if (!hit) continue;
      writeFileSync(file, JSON.stringify(raw, null, 2));
      purged.push(path.basename(file));
    } catch {
      /* 读不出/写不了：不动它（宁可留着，也不要写坏用户的配置） */
    }
  }
  return purged;
}

export function apply(ctx: any, _config: any = {}) {
  // ④ 安装生命周期 —— 启动对账（判据 2）必须跑在**任何状态加载之前**：
  //    这样"卸载后重装"的这次启动从一开始就是空状态（不会先把老 session/panel 读进内存再删文件）。
  const profileDir = resolveProfileDir(ctx);
  if (!profileDir) {
    stateLog("install-ledger: 取不到 profile 目录（profileContext 缺失且向上没找到 dsh.profile.bundles）");
  }
  const reconcile = reconcileInstallLedger(profileDir);
  // ② 老配置清理必须在 loadPanelState() 之前跑：这样"内存里的 state"从一开始就不含明文口令。
  const purgedFiles = purgeLegacyPlaintextPassword();
  let state: PanelState = { ...defaultState(), ...loadPanelState() };
  // 清理结果要写 host.log，但日志函数在下面才定义 → 先记下来，稍后补写。
  const bootNotices: string[] = purgedFiles.length
    ? [`purged legacy plaintext password from ${purgedFiles.join(", ")}（只删 password 字段，其它字段未改动）`]
    : [];
  // ④ 对账结论也要写进 host.log（日志函数在下面才定义）
  bootNotices.push(
    `install-ledger: profileDir=${profileDir ?? "(未识别)"} 对账结论=${reconcile.reason}` +
      (reconcile.wiped ? "（本次已清除本机凭据 ⇒ 空状态，需要重新登录）" : "（凭据未改动）"),
  );

  let child: ReturnType<typeof spawn> | null = null;
  let stopped = false;
  let session: Session | null = loadSession();
  let grantSecret = ""; // 领取凭证：只存内存，绝不下地
  let pollTimer: ReturnType<typeof setInterval> | null = null;
  let lastConfig: PanelState | null = null;
  let lastRespawnAt = 0;
  let yieldRetries = 0; // 让位/被占用后的礼貌重试次数（成功启动即清零）
  // 手动连接标记：仅用于「显式关掉 autoConnect」的用户（默认路径不再需要它）。
  let startedByUser = false;
  let heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  // 新版 DSH（v0.1.5+）鉴权：connection 服务提供的进程 launch token（每次 DSH 启动换新）。
  // 桥子进程用它做一次性 Cookie 换发。老版 DSH 无 connection 服务 → token 保持空，
  // 桥按无鉴权模式直连（向后兼容）。
  let dshLaunchToken = "";
  // ★ 端口**绝不猜**（1.0.7 起）：0 = 未解析；解析值只来自 DSH `webServer` 服务的真实监听端口
  //   （任何载体都成立，含官方桌面 `--port 0` 的随机端口）。显式覆盖：环境变量 DSHMOBILE_DSH_URL。
  let webServerPort = 0;
  let webServerPortSource = "";
  let tokenPollTimer: ReturnType<typeof setInterval> | null = null;
  let booted = false; // apply 尾部置 true；避免启动期 port 解析与 scheduleConfig 抢跑互相重启桥

  function dshBaseUrl(): string {
    const env = process.env.DSHMOBILE_DSH_URL;
    if (env) return env.replace(/\/+$/, "");
    if (webServerPort > 0) return `http://127.0.0.1:${webServerPort}`;
    return ""; // 未解析：调用方（起桥/取 token）必须显式处理，绝不猜 3080
  }

  /** 宿主关键事件落盘（stdio 不可见时也能诊断）。 */
  function hostLog(msg: string) {
    stateLog(msg);
  }

  // 启动期的清理/状态说明（此时日志函数已可用）
  for (const n of bootNotices) hostLog(n);

  /** 桥是否具备可用凭据：宿主手上的会话，或用户本次填写的账号密码。
   *  ⚠ 只看用户名不算 —— 用户名只是预填值，令牌/密码才是凭据。 */
  function hasBridgeCreds(): boolean {
    return session !== null || Boolean(state.username && state.password);
  }

  /** 「自动连接」的**有效配置**（不含"用户本次点过连接"这个临时状态）—— 面板显示与本机行为都以它为准。
   *  优先级：插件配置 `{autoConnect:false}` > panel.json 的 autoConnect > 默认 true。 */
  function autoConnectEffective(): boolean {
    const configured = typeof _config?.autoConnect === "boolean" ? _config.autoConnect : undefined;
    return (configured ?? state.autoConnect) !== false;
  }

  /** 是否允许本宿主启动/维持桥与 relay 连接。
   *  ★ 1.0.5 起**默认允许**（对标微信/淘宝：正常启动 / DSH 重启 / 插件更新后都自动登录）。
   *  只有**显式关闭**才退化为"必须用户点一次『保存并连接』"：
   *    · 插件配置 `{autoConnect:false}`（优先级最高，来自 cordis.patch.yml 的 config）；或
   *    · `panel.json` 里的 `autoConnect:false`（用户显式关掉；1.0.5 默认写的是 true）。
   *  用户点过连接（startedByUser）时始终允许 —— 手动动作永远优先于配置。 */
  function bridgeAllowed(): boolean {
    return startedByUser || autoConnectEffective();
  }
  function bridgeShouldRun(): boolean {
    return state.enabled && bridgeAllowed() && hasBridgeCreds();
  }

  // 诊断日志去重：同一类失败只报一次（变化时报），根治 host.log 每秒刷屏
  let lastTokenDiag = "";
  function tokenDiag(source: string, msg: string) {
    if (msg === lastTokenDiag) return;
    lastTokenDiag = msg;
    hostLog(`token[${source}]: ${msg}`);
  }
  let lastRpcDiag = "";
  function rpcDiag(source: string, msg: string) {
    if (msg === lastRpcDiag) return;
    lastRpcDiag = msg;
    hostLog(`rpc[${source}]: ${msg}`);
  }

  /** 记录 DSH webServer 真实端口（`ws.port` 在任何载体下都返回实际监听端口，含 `--port 0` 随机分配）。
   *  端口第一次解析/发生变化时：若桥已在跑则用新地址重启；若桥此前因"端口未解析"没起，则补起。 */
  function recordWebServer(ws: any, source: string): void {
    try {
      const port = ws?.port;
      if (Number.isInteger(port) && port > 0 && port !== webServerPort) {
        webServerPort = port;
        webServerPortSource = source;
        hostLog(`port[${source}]: resolved http://127.0.0.1:${port}`);
        if (booted && bridgeShouldRun()) startBridge(state);
      }
    } catch { /* 读不到端口就保持未解析；失败在 applyToken 里统一报 */ }
  }

  /** 从 connection 服务提取 launch token；成功返回 true。多渠道共用，保证不重不漏。
   *  端口与 token 分开记：端口未解析也能继续等（轮询不会停），但**不猜端口**。 */
  function applyToken(connectionCtx: any, source: string): boolean {
    try {
      // 端口：注入式 ctx 用属性直取；sync/poll 传的 {connection,webServer} 普通对象同样兼容
      const ws = connectionCtx?.webServer ?? connectionCtx?.get?.("webServer");
      if (ws) recordWebServer(ws, source);
      if (!dshBaseUrl()) {
        tokenDiag(source, "waiting: webServer 端口未解析（不猜端口，继续轮询）");
        return false;
      }
      const conn = connectionCtx?.connection ?? connectionCtx?.get?.("connection");
      if (!conn || typeof conn.authenticatedUrl !== "function") {
        tokenDiag(source, "connection service not visible");
        return false;
      }
      const authed = conn.authenticatedUrl(dshBaseUrl());
      const token = new URL(authed).searchParams.get("token") ?? "";
      if (token && token !== dshLaunchToken) {
        dshLaunchToken = token;
        hostLog(`token[${source}]: acquired (bridge will authenticate /api)`);
        // ⚠ 只"续"不"起"：桥已经在跑才用新 token 重启它；桥没跑就绝不在这里启动（起桥只由
        //    bridgeShouldRun()/bridgeAllowed() 决定，见 onConfig 与 startBridge）。
        if (state.enabled && hasBridgeCreds() && bridgeAllowed() && child) {
          startBridge(state);
        }
      }
      return Boolean(token);
    } catch (err: any) {
      tokenDiag(source, `failed: ${err?.message ?? err}`);
      return false;
    }
  }

  /* ==================== 首选通道：官方连接服务 RPC（能力探测） ====================
     探测条件是**唯一判据**，故意不看 DSH 版本号（版本号不可靠）：
       typeof ctx.connection?.rpc?.handle === "function"
     探测失败 ⇒ 什么都不做，面板继续走下面的本地 HTTP 兜底（旧代码一字未删）。
     通道名 RPC_CHANNEL 带前导斜杠；handler 必须返回官方信封：
       { ok: true, value } | { ok: false, error: { code, message, details } }
     （官方在 handler 抛异常时会把响应变成 HTTP 500 文本，所以这里全量 try/catch 成错误信封，
       保证面板侧拿到的是**业务错误**而不是"传输失败"，从而不会误触发回退。） */
  let rpcRegistered = false;
  let rpcSource = "";
  let rpcDispose: (() => void) | null = null;

  /** 面板状态快照：HTTP `GET /state` 与 rpc `state` endpoint 共用同一份，两条通道数据必然一致。 */
  function panelSnapshot() {
    ensureE2eeCode();
    // E2EE 运行时状态随每次取状态现读（策略文件 + device-key.json），面板刷新即可反映手机端操作
    const rt = readE2eeRuntime();
    return {
      ...state,
      // ④ 面板据此把"没凭据"显示成「未连接」。loggedIn **现场推导**（会话在手 或 本次填了密码），
      //    不再拿"用户名非空"当登录判据 —— 用户名只是预填值，不代表可用凭据。
      loggedIn: session !== null || Boolean(state.username && state.password),
      // 面板按「有效配置」显示：插件配置/panel.json 显式关掉时，面板要说"自动连接已关闭"
      autoConnect: autoConnectEffective(),
      e2eeRequire: rt.require,
      e2eePinned: rt.pinned,
      e2eePeerKeyId: rt.peerKeyId ? rt.peerKeyId.slice(0, 12) : "",
    };
  }

  /** RPC handler：`(endpoint, payload) => Promise<信封>`；payload 与旧 HTTP body 完全同形。 */
  async function handleRpc(endpoint: string, payload: any) {
    try {
      switch (endpoint) {
        case "state":
          return { ok: true, value: panelSnapshot() };
        case "action":
          await handleAction(String(payload?.action ?? ""), payload?.payload);
          return { ok: true, value: null };
        default:
          return {
            ok: false,
            error: {
              code: "dshmobile/unknown-endpoint",
              message: `unknown endpoint: ${endpoint}（可用：state / action）`,
              details: {},
            },
          };
      }
    } catch (err: any) {
      return { ok: false, error: { code: "dshmobile/failed", message: String(err?.message ?? err), details: {} } };
    }
  }

  /** RPC 通道请求处理（直接挂载形态）：解析官方 client-request 信封 → handleRpc → server-response 信封。
   *  栅栏复用官方 `connection.admit`（Host/Origin 403 + 浏览器会话 401；dsh-tauri 等载体按需改写其语义）。 */
  function handleRpcHttpRequest(req: any, res: any, conn: any) {
    const finish = (code: number, body: any) => {
      res.writeHead(code, { "content-type": "application/json", "cache-control": "no-store" });
      res.end(JSON.stringify(body));
    };
    try {
      if (conn && typeof conn.admit === "function") {
        const admission = conn.admit(req);
        if (admission && "rejection" in admission) {
          res.writeHead(admission.rejection);
          res.end(admission.rejection === 401 ? "unauthorized" : "forbidden");
          return;
        }
      }
      let raw = "";
      req.on("data", (c: any) => { if (raw.length < 2_000_000) raw += c; });
      req.on("end", () => {
        let body: any = null;
        try { body = JSON.parse(raw || "{}"); } catch { body = null; }
        if (!body || body.type !== "client-request" || typeof body.rpcId !== "string" || typeof body.method !== "string") {
          finish(400, { type: "server-response", rpcId: "invalid-request", result: { ok: false, error: { code: "dshmobile/invalid-request", message: "invalid client-request envelope", details: {} } } });
          return;
        }
        (async () => {
          try {
            const result = await handleRpc(body.method, body.payload);
            finish(200, { type: "server-response", rpcId: body.rpcId, result });
          } catch (err: any) {
            finish(500, { type: "server-response", rpcId: body.rpcId, result: { ok: false, error: { code: "dshmobile/failed", message: String(err?.message ?? err), details: {} } } });
          }
        })();
      });
    } catch {
      try { res.writeHead(500); res.end(); } catch { /* 连接已断 */ }
    }
  }

  /**
   * 注册官方 RPC 通道（幂等：成功一次就够）。**两条注册形态**：
   *   ★ 直接挂载（与官方 /api 同款）：把 RPC_CHANNEL 作为 prefix 路由注册到 DSH webServer，
   *     信封与官方 rpc 通道一致。用于 `connection.rpc.handle` 不可用的 DSH 版本 ——
   *     其 register 把 owner 固定为 connection 服务自身 ctx（该 ctx 只注入 credentials），
   *     必抛 "cannot get property webServer without inject"（0.1.7-rc.2 / 0.2.0-rc.2 实测）。
   *   ☆ rpc.handle（未来版本可能修复 owner 语义）：直接挂载不可用时再试。
   * @param source 诊断用来源标记（sync / inject / poll）
   * @param contextCtx 已注入 connection/webServer 的上下文（声明式路径用），缺省则用宿主根 ctx 现探
   * @returns 通道是否可用（false = 保持 HTTP 兜底，不改变任何旧行为）
   */
  function tryRegisterRpc(source: string, contextCtx?: any): boolean {
    if (rpcRegistered) return true;
    // ① 直接挂载（优先：不依赖 connection 服务的 owner ctx）
    try {
      const base = contextCtx ?? ctx;
      const ws = base?.get?.("webServer") ?? ctx?.get?.("webServer") ?? ctx?.root?.get?.("webServer");
      const conn = base?.get?.("connection") ?? ctx?.get?.("connection") ?? ctx?.root?.get?.("connection");
      if (ws && typeof ws.register === "function") {
        const route = { kind: "prefix", path: RPC_CHANNEL, handler: (req: any, res: any) => handleRpcHttpRequest(req, res, conn) };
        const disposeRoute = ws.register(route);
        if (typeof ctx?.effect === "function") ctx.effect(() => disposeRoute, "dshmobile: rpc route (direct)");
        rpcDispose = disposeRoute;
        rpcRegistered = true;
        rpcSource = `${source}-direct`;
        hostLog(`rpc[${source}]: ${RPC_CHANNEL} 通道已直接注册到 webServer（官方 rpc.handle 不可用时的等价通道；本地 HTTP 兜底仍在监听 ${HTTP_PORT})`);
        return true;
      }
    } catch (err: any) {
      rpcDiag(source, `direct unavailable: ${err?.message ?? err}`);
    }
    // ② 官方 rpc.handle（兜底形态；未来 DSH 修复 owner 语义后自动走这里）
    try {
      const base = contextCtx ?? ctx;
      let conn: any;
      // cordis 里读未注入的服务属性会抛（"cannot get property ... without inject"）→ 单独 catch
      try { conn = base?.connection; } catch { conn = undefined; }
      // 不触发 inject 要求的读取（宿主本插件**故意不声明** connection 硬依赖，见"途径 0"说明）
      if (!conn) {
        try { conn = ctx?.get?.("connection") ?? ctx?.root?.get?.("connection"); } catch { conn = undefined; }
      }
      const rpc = conn?.rpc;
      if (typeof rpc?.handle !== "function") return false;
      rpc.handle(RPC_CHANNEL, (endpoint: string, payload: any) => handleRpc(endpoint, payload));
      rpcRegistered = true;
      rpcSource = source;
      hostLog(`rpc[${source}]: ${RPC_CHANNEL} channel registered (官方 rpc.handle；本地 HTTP 兜底仍在监听 ${HTTP_PORT})`);
      return true;
    } catch (err: any) {
      rpcDiag(source, `unavailable: ${err?.message ?? err}`);
      return false;
    }
  }

  // 途径 0（官方声明式形态）：把一个「声明 inject: ["connection","webServer"]」的子插件挂到本插件下。
  //   ⚠ 为什么不直接在本插件顶层写 `export const inject = ["connection"]`：
  //     顶层 inject 是**硬依赖**，服务缺席时 cordis 会把整个宿主插件挂起（pending）——
  //     连桥进程和本地 HTTP 兜底都起不来。而本插件承诺兼容"没有 connection 服务的老版 DSH"
  //     （见上方 dshLaunchToken 的说明），所以这里把硬依赖降级成一个**子 fiber**：
  //     服务到位 → 子插件 apply → 取端口/token + 注册通道；服务永不到位 → 只有子 fiber 挂起，宿主本体照常工作。
  //     ★ webServer 必须一并注入：读端口与注册 RPC 通道都要它（1.0.6 只注入 connection ⇒
  //       端口读不到退化猜 3080、rpc 通道注册必抛 "cannot get property webServer without inject"）。
  try {
    ctx.plugin?.({
      name: "dshmobile-rpc",
      inject: ["connection", "webServer"],
      apply(connCtx: any) {
        applyToken(connCtx, "inject");
        tryRegisterRpc("inject", connCtx);
      },
    });
  } catch (err: any) {
    hostLog(`rpc[inject]: plugin mount failed: ${err?.message ?? err}`);
  }

  // 途径 1：同步直取（connection/webServer 服务可能已就绪；顺带立刻注册 RPC 通道，不依赖回调时序）
  try {
    const conn = ctx?.get?.("connection") ?? ctx?.root?.get?.("connection");
    const ws = ctx?.get?.("webServer") ?? ctx?.root?.get?.("webServer");
    if (conn || ws) applyToken({ connection: conn, webServer: ws }, "sync");
    else tokenDiag("sync", "connection/webServer 服务不可见");
  } catch (err: any) {
    tokenDiag("sync", `${err?.message ?? err}`);
  }
  tryRegisterRpc("sync");

  // 途径 2：事件驱动注入（官方形态；服务就绪后回调；同样带上 webServer）
  try {
    ctx.inject?.(["connection", "webServer"], (connectionCtx: any) => {
      applyToken(connectionCtx, "inject-cb");
      tryRegisterRpc("inject-cb", connectionCtx);
    });
  } catch (err: any) {
    tokenDiag("inject-cb", `unavailable: ${err?.message ?? err}`);
  }

  // 途径 3：轮询兜底（inject 不触发/作用域隔离时也能拿到；两项都拿到即停）
  //   节奏：前 RPC_PROBE_FAST_TICKS 秒每秒试一次；之后每 RPC_PROBE_SLOW_EVERY 秒试一次；
  //        超过 RPC_PROBE_GIVE_UP_TICKS 秒仍拿不到 rpc ⇒ 放弃官方通道（回落到旧版行为）。
  let pollTicks = 0;
  tokenPollTimer = setInterval(() => {
    pollTicks++;
    const needToken = !dshLaunchToken;
    // ★ 端口也算停轮条件：token 拿到了但端口还没解析时**必须继续轮询**（旧代码会在端口仍错时提前停掉）
    const needPort = webServerPort === 0 && !process.env.DSHMOBILE_DSH_URL;
    const needRpc = !rpcRegistered && pollTicks <= RPC_PROBE_GIVE_UP_TICKS;
    if (!needToken && !needPort && !needRpc) {
      if (tokenPollTimer) { clearInterval(tokenPollTimer); tokenPollTimer = null; }
      return;
    }
    if (needToken || needPort) {
      try {
        const conn = ctx?.get?.("connection") ?? ctx?.root?.get?.("connection");
        const ws = ctx?.get?.("webServer") ?? ctx?.root?.get?.("webServer");
        if (conn || ws) applyToken({ connection: conn, webServer: ws }, "poll");
        else tokenDiag("poll", "connection/webServer 服务不可见");
      } catch {
        /* 下一轮再试 */
      }
    }
    if (needRpc && (pollTicks <= RPC_PROBE_FAST_TICKS || pollTicks % RPC_PROBE_SLOW_EVERY === 0)) {
      tryRegisterRpc("poll");
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
    } else if (state.bridgeStatus === "stopped") {
      return; // 幂等：本来就没有桥、状态也已经是 stopped，不要重复写状态（避免把 "running" 之外的提示覆盖掉）
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

  /**
   * 启动桥子进程（默认路径：宿主启动时由 autoConnect 自动拉起；显式关掉时只由「保存并连接」触发）。
   * @returns 桥是否真的被拉起（false = 缺凭据/未获授权，调用方据此给面板提示）
   */
  function startBridge(value: PanelState, opts: { noYield?: boolean } = {}): boolean {
    // 只有**显式**关了 autoConnect 且用户没点过连接时才拦下来（默认路径不拦）。
    if (!bridgeAllowed()) {
      hostLog("startBridge skipped: autoConnect=false（显式关闭）且未点「保存并连接」");
      return false;
    }
    // 只有用户名、没有任何可用凭据（无会话且本次没填密码）→ 不启动，等用户填密码或扫码授权。
    // 这样本插件永远不会在用户没提供凭据的情况下尝试登录 relay。
    if (!hasBridgeCreds()) {
      patchState({ bridgeStatus: "needs-login" });
      hostLog("startBridge skipped: 无可用凭据（无会话且未填密码）");
      return false;
    }
    // ★ 端口未解析绝不猜（不再硬编码 3080）：等 webServer 端口就绪，或用 DSHMOBILE_DSH_URL 显式指定。
    //   端口错误时写进 config.json 的 dsh.url 必然错，桥起来也连不上 DSH —— 宁可不起、明确报状态。
    if (!dshBaseUrl()) {
      patchState({ bridgeStatus: "dsh-port-unresolved（等待 DSH web 服务端口就绪）" });
      hostLog("startBridge skipped: DSH webServer 端口未解析；不猜端口，可用环境变量 DSHMOBILE_DSH_URL 显式指定");
      return false;
    }
    stopBridge();
    takeoverStaleBridges();
    try {
      mkdirSync(STATE_DIR, { recursive: true });
      const cfg: Record<string, any> = {
        relay: {
          url: value.relayUrl,
          username: value.username || session?.username || "",
          // ⚠ 有会话时**绝不**把明文口令写进 config.json（1.0.4 起口令只在内存里用于换令牌）：
          //    正常流程走 bootInteractively() → 换到令牌后口令已从内存清空，这里必然是空串。
          //    "手机扫码授权"模式下也必然是空串。
          password: session ? "" : value.password,
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
      // ① 心跳文件名与阈值一起传给桥：桥据此监测"宿主还在不在"（宿主不在 ⇒ 桥自杀）。
      //    阈值同时作为桥自己的默认值来源，两端口径必然一致（不再各自写死）。
      cfg[HEARTBEAT_FIELD] = HEARTBEAT_FILE;
      cfg[HEARTBEAT_STALE_FIELD] = HEARTBEAT_STALE_MS;
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
            if (!hasBridgeCreds()) return;
            startBridge(state, { noYield: true });
          }, delay);
          return;
        }
        // 异常退出则 3 秒后自动拉起（60 秒内最多一次，防崩溃循环）
        // ⚠ 退出码 44 = 桥自己发现"宿主心跳过期"而自杀（见 bridge/main.js hostWatchdog）。
        //   那不是崩溃，**绝不能自动拉起** —— 否则会变成"自杀→重启"死循环。
        patchState({ bridgeStatus: code === BRIDGE_EXIT_HOST_GONE ? "host-heartbeat-stale" : `exited:${code}，3 秒后自动重启` });
        if (code === BRIDGE_EXIT_HOST_GONE) {
          hostLog(`bridge exited ${code}: 桥检测到宿中心跳过期而退出（本宿主不再自动拉起）`);
          return;
        }
        const now = Date.now();
        if (now - lastRespawnAt > 60_000) {
          lastRespawnAt = now;
          setTimeout(() => {
            if (!stopped && state.enabled && hasBridgeCreds() && bridgeAllowed()) {
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
      return true;
    } catch (err: any) {
      patchState({ bridgeStatus: `error:${err?.message ?? err}` });
      return false;
    }
  }

  /**
   * E2EE 运行时状态（供面板显示）：策略 `require` + 是否已与手机配对。
   * 每次 /state 都重新读文件 → 手机端扫码配对/改用明文后，面板刷新即可看到（最多一个轮询周期）。
   */
  function readE2eeRuntime(): { require: boolean; pinned: boolean; peerKeyId: string } {
    let require = true;
    try {
      const p = JSON.parse(readFileSync(E2EE_POLICY_FILE, "utf8"));
      if (typeof p?.require === "boolean") require = p.require;
    } catch { /* 缺失/坏文件 → 与桥一致：要求加密 */ }
    let pinned = false;
    let peerKeyId = "";
    try {
      const d = JSON.parse(readFileSync(DEVICE_KEY_FILE, "utf8"));
      if (typeof d?.pinnedPeer?.keyId === "string" && d.pinnedPeer.keyId) {
        pinned = true;
        peerKeyId = d.pinnedPeer.keyId;
      }
    } catch { /* 读不出 → 视为未配对 */ }
    return { require, pinned, peerKeyId };
  }

  /** 写 E2EE 策略（原子写，格式与桥侧一致）。 */
  function writeE2eeRequire(require: boolean): void {
    try {
      mkdirSync(STATE_DIR, { recursive: true });
      const tmp = `${E2EE_POLICY_FILE}.tmp-${process.pid}`;
      writeFileSync(tmp, JSON.stringify({ require }, null, 2), { mode: 0o600 });
      renameSync(tmp, E2EE_POLICY_FILE);
      hostLog(`e2eePolicy: require=${require}（面板操作）`);
    } catch (err: any) {
      hostLog(`e2eePolicy: 写入失败：${err?.message ?? err}`);
    }
  }

  /** 解除 E2EE 配对（清 pinnedPeer，保留本机身份；桥重启后生效）。 */
  function clearPinnedPeer(): void {
    try {
      const d = JSON.parse(readFileSync(DEVICE_KEY_FILE, "utf8"));
      if (d?.pubKey && d?.privKey && d?.keyId) {
        writeFileSync(DEVICE_KEY_FILE, JSON.stringify({ ...d, pinnedPeer: null }, null, 2), { mode: 0o600 });
        hostLog("e2eePolicy: 已清除 pinnedPeer（解除配对）");
      }
    } catch (err: any) {
      hostLog(`e2eePolicy: 清除 pin 失败：${err?.message ?? err}`);
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

  /** 拿可用 access token：会话优先；没有会话时才用内存里的账号密码换一次令牌。
   *  ⚠ 密码**只活在内存**（panel.json / config.json 都不再保存，启动时会自动清理）：它是"换令牌"的一次性输入，
   *  换到令牌后立刻从内存清掉（令牌落 session.json），从而避免任何时刻的明文口令落盘。 */
  async function obtainAccessToken(base: string): Promise<string> {
    if (session?.accessToken) return session.accessToken;
    if (!state.username || !state.password) {
      throw new Error("本机尚未登录：请用手机 App 扫码授权，或在卡片填写账号密码");
    }
    const login = await restJson(base, "/auth/login", {
      method: "POST",
      body: JSON.stringify({ username: state.username, password: state.password }),
    });
    // 令牌已到手 → 内存里的明文口令可以丢了（会话由 session.json 承载）
    if (login?.data?.accessToken && login?.data?.refreshToken) {
      session = {
        accessToken: login.data.accessToken,
        refreshToken: login.data.refreshToken,
        username: login.data.user?.username ?? state.username,
      };
      saveSession(session);
      patchState({ password: "", loggedIn: true });
      hostLog("auth: 账号密码换令牌成功（明文口令已从内存清除，未落盘）");
    }
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
          // 手机扫码授权成功 = 用户显式动作 ⇒ 允许起桥；但仍尊重"未获授权就不起"的总闸门
          if (bridgeShouldRun()) startBridge(state);
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

  /** 退出登录：清本机会话与账号显示 → 停桥 → 转回授权码模式。
   *  ⚠ 语义边界（与面板「清除本机凭据」严格区分）：
   *    · 退出登录 = **服务端登出语义**：丢弃本机会话/账号，桥停掉；二维码转回授权模式，手机仍可扫码授权本机登录。
   *    · 清除本机凭据 = **只清本机**：丢掉会话与预填账号，且**不再主动连**（二维码也不自动重出）。 */
  async function handleLogout() {
    session = null;
    grantSecret = "";
    stopPolling();
    try {
      rmSync(SESSION_FILE, { force: true });
    } catch {}
    stopBridge();
    startedByUser = false; // 退出登录后回到"未连接、等用户点连接"的状态
    patchState({
      username: "",
      password: "",
      loggedIn: false,
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

  /** 「清除本机凭据」：把**这台机器上的身份/登录痕迹**清干净（不只是 token）。
   *  清单 = CREDENTIAL_FILES：会话令牌 + 桥配置 + 预填账号 + relay 设备 ID + **E2EE 设备私钥**
   *  + DSH API Cookie 缓存 + 配对 secret + 机器标识。
   *  与「退出登录」的区别：退出登录只丢会话（设备身份/私钥都留着，扫个码就能回来）；
   *  清除本机凭据是"换一台新机器"的语义 —— 之后必须完整重新登录（可能还要重新做 E2EE 配对）。 */
  async function clearLocalCredentials() {
    session = null;
    grantSecret = "";
    stopPolling();
    stopBridge();
    startedByUser = false;
    patchState({
      username: "",
      password: "",
      loggedIn: false,
      mode: "grant",
      pairingCode: "",
      pairingExpiresAt: "",
      grantPairingId: "",
      registerError: "",
      pairError: "",
      bridgeStatus: "stopped",
    });
    const wiped = wipeLocalCredentials("面板动作 clearCredentials（用户显式清除本机凭据）");
    // ⚠ 这里**不再** savePanelState(state)：panel.json 已被删除，写回去等于"清完又落盘账号"。
    hostLog(`clearCredentials: 本机凭据已清除（删除 ${wiped.deleted.join(", ") || "无"}；桥已停）`);
    scheduleConfig();
  }

  /** 「保存并连接」= 用户显式授权连桥：此后才允许起桥 / 连 relay / 自动出码。
   *  ⚠ 顺序：**先用密码换令牌（内存）→ 再起桥**。这样桥的 config.json 里只有令牌，永远不含明文口令。 */
  async function bootInteractively() {
    startedByUser = true;
    hostLog(`connect: 用户显式触发（autoConnect=${autoConnectEffective()}）`);
    // 用户本次填了密码：先换令牌（令牌落 session.json），再起桥 ⇒ 明文口令不落盘
    if (state.username && state.password) {
      try {
        await obtainAccessToken(state.relayUrl.replace(/\/$/, ""));
        patchState({ pairError: "" });
        hostLog("connect: 已用账号密码换取令牌（明文口令未落盘，已从内存清除）");
      } catch (err: any) {
        const msg = String(err?.message ?? err);
        patchState({ pairError: `账号密码登录失败（${msg}）；也可用手机 App 扫码授权本机登录` });
        hostLog(`connect: 账号密码登录失败：${msg}`);
      }
    }
    await onConfig();
    // ⚠ 必须补这一下：onConfig 的"该不该起桥"是**变化检测**，而 prevShouldRun / shouldRun 都用
    //   **当前**的 bridgeAllowed() 求值 —— 用户点连接只改了 startedByUser（不是 state 字段），
    //   两边会同时变成 true ⇒ 检测不到变化 ⇒ 表单没改动时点「保存并连接」将毫无反应（实测踩到）。
    //   显式关闭 autoConnect 的用户全靠这个按钮，所以这里必须自己起桥。
    if (bridgeShouldRun() && !child) startBridge(state);
    // 既没有会话、也没有可用密码 → 桥起不来；明确告诉用户缺什么，而不是静默失败
    if (state.enabled && !session && !state.password) {
      patchState({
        pairError: state.username
          ? "本机缺少可用凭据：请输入密码后重试，或用手机 App 扫码授权本机登录"
          : "请填写账号与密码，或用手机 App 扫码授权本机登录",
      });
    }
  }

  async function onConfig() {
    const next = { ...state };
    const prev = lastConfig;
    lastConfig = next;
    // 桥启停（配置变化或首次装载）
    // ④ 首次装载时 shouldRun 由 bridgeShouldRun() 决定：**默认自动连接** ⇒ 有凭据就 spawn（自动登录）。
    //    只有显式 autoConnect=false 时才停在 stopped，等用户点「保存并连接」。
    const shouldRun = next.enabled && bridgeAllowed() && (session !== null || Boolean(next.username && next.password));
    const prevShouldRun = prev
      ? prev.enabled && bridgeAllowed() && (session !== null || Boolean(prev.username && prev.password))
      : false;
    const cfgChanged =
      !prev ||
      prev.relayUrl !== next.relayUrl ||
      prev.username !== next.username ||
      prev.password !== next.password ||
      prev.deviceLabel !== next.deviceLabel ||
      prev.enabled !== next.enabled ||
      prev.autoConnect !== next.autoConnect;
    if (cfgChanged || shouldRun !== prevShouldRun) {
      // 幂等：shouldRun=true 时重复 startBridge 会重启桥，所以只在"没有桥"时启动
      if (shouldRun) { if (!child) startBridge(next); }
      else stopBridge();
    }
    // 常驻二维码：凭据变化/尚无有效码时（重新）出码。
    // 默认路径（自动登录）下这里也自动出码；只有显式 autoConnect=false 时才不主动连 relay，
    // 面板显示"未生成：点「保存并连接」后才会出码"。
    const credsChanged = !prev || prev.username !== next.username || prev.password !== next.password;
    if (bridgeAllowed() && (credsChanged || !next.pairingCode)) {
      await ensureQr();
    }
  }

  /** 面板动作分发。 */
  async function handleAction(action: string, payload: any) {
    switch (action) {
      case "save": {
        // ⚠ password 只进内存、绝不落盘（savePanelState 不再持久化它）；autoConnect 可被显式打开。
        for (const k of ["relayUrl", "username", "password", "deviceLabel", "enabled", "autoConnect"]) {
          if (payload && payload[k] !== undefined) (state as any)[k] = payload[k];
        }
        savePanelState(state);
        scheduleConfig();
        break;
      }
      case "connect": {
        await bootInteractively();
        break;
      }
      case "disconnect": {
        startedByUser = false;
        stopBridge();
        hostLog("disconnect: 用户断开（桥已停，relay 连接随之中断）");
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
      case "clearCredentials": {
        await clearLocalCredentials();
        break;
      }
      case "e2eePolicy": {
        // 面板侧切换 E2EE 策略（与手机端"永久改用非加密"等价）：
        //  require=false → 记策略 + 解除配对（清 pinnedPeer）；require=true → 恢复要求加密（保留身份）。
        // 桥只在启动时读策略与身份文件 ⇒ 写完重启桥（几秒中断），保证内存态与磁盘一致。
        const require = payload?.require === true;
        writeE2eeRequire(require);
        if (!require && payload?.clearPin !== false) clearPinnedPeer();
        startBridge(state);
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

  /** 兜底路径：127.0.0.1 本地 HTTP 服务：面板轮询 /state、下发 /action（CORS 仅放行本机来源）。 */
  function startServer() {
    const server = createServer((req, res) => {
      const origin = String(req.headers.origin ?? "");
      // ★ 2026-09-29：**放宽为回显请求方 origin**（原来是只认 127.0.0.1/localhost 的正则）。
      //   起因：官方**桌面版 DSH（0.2.0）**里面板报 `TypeError: Failed to fetch`，而同一插件在
      //   `dsh web`（浏览器开 http://127.0.0.1:3080）里正常 —— 差别就是**渲染进程的 origin**：
      //   桌面版若不是 `http://127.0.0.1:port` 这种写法（自定义 scheme / file:// / app://，
      //   origin 可能是 "null" 或别的值），旧正则判不匹配 ⇒ 回 `ACAO: "null"` ⇒ 浏览器**直接拦掉**
      //   ⇒ 面板只看到一句 `Failed to fetch`（浏览器故意不给细节）。
      //   ⚠ 安全性不变：本服务只绑回环（listen(HTTP_PORT, "127.0.0.1")），外网访问不到。
      //   ⚠ origin 缺失（同源请求 / 非浏览器客户端）时回 `*`，与旧行为等价可用。
      const acao = origin && origin !== "null" ? origin : "*";
      const headers: Record<string, string> = {
        "Access-Control-Allow-Origin": acao,
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
        // 与 rpc 的 "state" endpoint 共用 panelSnapshot()：两条通道返回同一份数据
        send(200, { ok: true, data: panelSnapshot() });
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

  /* ==================== ① 宿主生命周期：心跳 + 卸载钩子 ====================
     为什么必须有这两条（实测缺陷）：卸载/关闭插件后，spawn 出来的桥可能继续在后台跑、继续连 relay，
     手机仍能操作这台电脑，只能手动 taskkill。而**插件被卸载时 DSH 进程还活着**，
     `process.ppid` / IPC 存活检查都发现不了 → 必须由宿主自己"报活"，并在卸载时主动收尾。 */

  /** 幂等收尾：卸载钩子与 apply 的返回值都指向它（两条路都注册，任一条生效即可）。
   *  ★ 1.0.5 起这里**同时**触发 ④ 判据 1（卸载当场清凭据）：只有"bundles 里已不含本包"
   *  才会落 tombstone 并轮询确认；App 退出 / 热重载（bundles 仍在）时一律不动凭据。 */
  let tornDown = false;
  function teardown(reason: string) {
    if (tornDown) return;
    tornDown = true;
    stopped = true;
    // 顺序很重要：先清掉心跳文件（桥下一次检查立刻发现"宿主不在了"），再杀子进程。
    if (heartbeatTimer) { clearInterval(heartbeatTimer); heartbeatTimer = null; }
    clearHeartbeat();
    const pid = child?.pid;
    stopPolling();
    stopBridge(); // 杀 spawn 出来的桥子进程（stopBridge 内部对 child 判空，幂等）
    if (tokenPollTimer) { clearInterval(tokenPollTimer); tokenPollTimer = null; }
    try { server.close(); } catch { /* 未监听/已关 */ }
    hostLog(`dispose: ${reason} → 心跳文件已清除、桥${pid ? `(pid=${pid})` : ""}已停止、面板 HTTP 已关闭`);
    // ④ 判据 1：桥已经停了，再判断这次 dispose 是不是"真卸载"（是则清凭据）
    try {
      onPluginDisposed(profileDir, reason);
    } catch (err: any) {
      hostLog(`uninstall-watch: 判定异常（已忽略，凭据不动）：${err?.message ?? err}`);
    }
  }

  // cordis 的正确卸载钩子（在 DSH 仓库的 cordis 里读过实现）：
  //  · `ctx.effect(fn)` 把 fn 注册到**当前插件 fiber**；fiber 卸载时按 LIFO 执行它返回的清理函数。
  //  · apply 返回的函数同样会被 `Fiber._execute()` 收进 `runner.collect` → 卸载时执行（本文件末尾的 return）。
  //  · ⚠ cordis **没有** `dispose` 事件（内部只发 `internal/plugin` / `internal/status`），
  //    所以这里用的是 `ctx.effect`，**不是** `ctx.on("dispose")` —— 后者永远不会触发。
  // 两条注册（effect + 返回值）都指向幂等的 teardown()，重复调用无副作用。
  try {
    if (typeof ctx?.effect === "function") {
      ctx.effect(() => {
        return () => teardown("插件 fiber 卸载（ctx.effect 清理回调）");
      });
    }
  } catch (err: any) {
    hostLog(`dispose: ctx.effect 注册失败（仍依赖 apply 返回值清理）：${err?.message ?? err}`);
  }

  // ★ 先写心跳文件，再 startServer()/scheduleConfig()：契约是"桥被 spawn 之前心跳必定已存在"。
  writeHeartbeat();
  heartbeatTimer = setInterval(writeHeartbeat, HEARTBEAT_WRITE_MS);
  hostLog(`heartbeat: ${HEARTBEAT_FILE}（每 ${HEARTBEAT_WRITE_MS / 1000}s 一次；桥容忍 ${HEARTBEAT_STALE_MS / 1000}s）`);

  const server = startServer();
  // 诊断一行：官方通道注册结果（rpcSource: sync / inject / inject-cb / poll；no = 只有 HTTP 兜底）
  hostLog(`plugin applied: dshUrl=${dshBaseUrl() || "(未解析)"} token=${dshLaunchToken ? "yes" : "no"} rpc=${rpcRegistered ? `yes(${rpcSource})` : "no"} port=${webServerPort > 0 ? `${webServerPort}(${webServerPortSource})` : "unresolved"}`);
  // 首次装载：默认 autoConnect=true ⇒ 有凭据就**自动起桥、自动出码**（自动登录，对标微信/淘宝）；
  // 只有显式 autoConnect=false 时才停在"未连接"，等用户点「保存并连接」。
  scheduleConfig();
  booted = true; // 启动期结束：此后端口解析成功会主动补起桥（见 recordWebServer）

  return () => teardown("插件卸载（apply 返回的 disposer）");
}
