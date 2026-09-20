// smoke-bridge-singleton.mjs：验证"同一 stateDir 只能有一个桥在跑"（根治双桥互踢）
//   ① 前提：同一回环端口第二次绑定必须失败（单例锁依赖这个 OS 语义）
//   ② 新实例让位协议：B 启动 → A 收到 yield 优雅退出（退出码 43）→ B 拿到锁
//   ③ 占用者不让位（老版本/卡死）→ 新实例以退出码 42 退出，绝不并存
//   ④ 父进程看门狗：宿主消失（IPC 断开）→ 桥退出，不留孤儿
//   ⑤ 逃生门：DSHMOBILE_BRIDGE_SINGLETON=0 时允许并存（临时第二桥/测试用）
// 全部使用真实 bridge/main.js 子进程；日志写文件（不用管道），配置指向不可达地址，绝不碰生产 relay。
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, openSync, closeSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import os from "node:os";
import path from "node:path";
import { EXIT_ANOTHER_INSTANCE, EXIT_YIELDED, singletonPort } from "../bridge/singleton.js";
import { killOtherBridges, scanBridgeProcs } from "../bridge/scan.js";

const HERE = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1"));
const BRIDGE = path.join(HERE, "..", "bridge", "main.js");
const tmp = mkdtempSync(path.join(os.tmpdir(), "dshm-singleton-"));
const children = [];

let pass = 0;
let fail = 0;
const log = (...a) => console.log(...a);
function ok(name, cond, extra = "") {
  if (cond) { pass++; log(`  ✅ ${name}${extra ? "  " + extra : ""}`); }
  else { fail++; log(`  ❌ ${name}${extra ? "  " + extra : ""}`); }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitFor(fn, { timeout = 8000, step = 100 } = {}) {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    if (await fn()) return true;
    await sleep(step);
  }
  return false;
}

function makeStateDir(tag) {
  const dir = path.join(tmp, tag);
  mkdirSync(dir, { recursive: true });
  const configPath = path.join(dir, "config.json");
  writeFileSync(
    configPath,
    JSON.stringify(
      {
        relay: { url: "http://127.0.0.1:9", username: "", password: "", deviceLabel: `singleton-${tag}`, platform: "windows", clientDeviceKey: `key-${tag}` },
        dsh: { url: "http://127.0.0.1:9", token: "", workspaceRoot: path.join(dir, "deliveries") },
        stateDir: dir,
      },
      null, 2,
    ),
    { encoding: "utf8" },
  );
  return { dir, configPath };
}

function startBridge({ configPath, tag, ipc = false, env = {} }) {
  const logPath = path.join(path.dirname(configPath), `${tag}.log`);
  const fd = openSync(logPath, "a");
  const stdio = ["ignore", fd, fd];
  if (ipc) stdio.push("ipc");
  const child = spawn(process.execPath, [BRIDGE, `--state-dir=${path.dirname(configPath)}`], {
    env: { ...process.env, DSHMOBILE_BRIDGE_CONFIG: configPath, ...env },
    stdio,
  });
  closeSync(fd);
  const rec = { child, logPath, tag, exited: null };
  child.on("exit", (code, signal) => { rec.exited = { code, signal }; });
  children.push(rec);
  return rec;
}
const readLog = (rec) => { try { return readFileSync(rec.logPath, "utf8"); } catch { return ""; } };

log(`临时目录：${tmp}`);
log(`桥入口：${BRIDGE}`);

// ---------- ① 端口互斥前提 ----------
{
  log("\n=== ① 回环端口第二次绑定必须失败（单例锁的前提）===");
  const port = singletonPort(makeStateDir("porttest").dir);
  const a = await new Promise((res) => { const s = createServer(); s.once("error", (e) => res({ s, err: e })); s.listen({ port, host: "127.0.0.1", exclusive: true }, () => res({ s, err: null })); });
  const b = await new Promise((res) => { const s = createServer(); s.once("error", (e) => res({ s, err: e })); s.listen({ port, host: "127.0.0.1", exclusive: true }, () => res({ s, err: null })); });
  ok("第一个绑定成功", a.err === null);
  ok("第二个绑定 EADDRINUSE", b.err?.code === "EADDRINUSE", `code=${b.err?.code ?? "(已绑定!)"}`);
  a.s.close(); b.s.close();
}

// ---------- ②/③ 让位与拒绝 ----------
{
  log("\n=== ② 新实例让位协议 + ③ 不让位则以 42 退出 ===");
  const { dir, configPath } = makeStateDir("main");
  const port = singletonPort(dir);

  const A = startBridge({ configPath, tag: "A" });
  ok("A 拿到单例锁", await waitFor(() => readLog(A).includes("已持有单实例锁")), "(等 A 启动)");
  ok("A 落盘 bridge.lock.json", existsSync(path.join(dir, "bridge.lock.json")));

  const B = startBridge({ configPath, tag: "B" });
  const bClaimed = await waitFor(() => readLog(B).includes("已持有单实例锁"), { timeout: 10000 });
  ok("B 最终拿到锁（旧实例让位）", bClaimed, readLog(B).includes("旧实例已让位") ? "（日志含『旧实例已让位』）" : "");
  ok("A 以退出码 43 让位退出", await waitFor(() => A.exited !== null, { timeout: 5000 }) && A.exited?.code === EXIT_YIELDED, `code=${A.exited?.code}`);
  const lockB = existsSync(path.join(dir, "bridge.lock.json")) ? JSON.parse(readFileSync(path.join(dir, "bridge.lock.json"), "utf8")) : {};
  ok("锁归属已换到 B", lockB.pid === B.child.pid, `lock.pid=${lockB.pid} B.pid=${B.child.pid}`);

  // ③ 模拟"占用者不让位"：用哑服务占住端口，再起一个桥
  B.child.kill();
  await waitFor(() => B.exited !== null, { timeout: 5000 });
  const dumb = createServer(() => { /* 不回应 yield */ });
  await new Promise((r) => dumb.listen({ port, host: "127.0.0.1", exclusive: true }, r));
  const C = startBridge({ configPath, tag: "C" });
  const cExited = await waitFor(() => C.exited !== null, { timeout: 8000 });
  ok("占用者不让位 → C 以退出码 42 退出", cExited && C.exited?.code === EXIT_ANOTHER_INSTANCE, `code=${C.exited?.code}`);
  ok("C 日志给出明确原因", readLog(C).includes("另一个桥实例仍占用单例端口"));
  dumb.close();
}

// ---------- ④ 父进程看门狗 ----------
{
  log("\n=== ④ 父进程看门狗（IPC 断开 → 桥退出，不留孤儿）===");
  const { configPath } = makeStateDir("watchdog");
  const D = startBridge({ configPath, tag: "D", ipc: true });
  ok("D 启动并拿到锁", await waitFor(() => readLog(D).includes("已持有单实例锁")));
  D.child.disconnect(); // 等价于宿主进程消失：IPC 通道关闭
  const gone = await waitFor(() => D.exited !== null, { timeout: 5000 });
  ok("父进程消失后 D 自动退出", gone, `code=${D.exited?.code}`);
  ok("退出原因写明是孤儿防护", readLog(D).includes("父进程（DSH 插件宿主）已消失"));
}

// ---------- ⑤ 逃生门 ----------
{
  log("\n=== ⑤ DSHMOBILE_BRIDGE_SINGLETON=0 时允许并存（临时第二桥）===");
  const { configPath } = makeStateDir("escape");
  const E = startBridge({ configPath, tag: "E", env: { DSHMOBILE_BRIDGE_SINGLETON: "0" } });
  const F = startBridge({ configPath, tag: "F", env: { DSHMOBILE_BRIDGE_SINGLETON: "0" } });
  await sleep(3000);
  ok("E 仍存活", E.exited === null);
  ok("F 仍存活（未被单例拒绝）", F.exited === null);
  ok("日志提示已关闭保护", readLog(E).includes("单实例保护已按 DSHMOBILE_BRIDGE_SINGLETON 关闭"));
}

// ---------- ⑥ 桥进程扫描/清理的分类正确性 ----------
{
  log("\n=== ⑥ 桥进程扫描：同身份清掉、旧版本归类、不同身份不动 ===");
  const { dir } = makeStateDir("scan");
  const fakeBridge = (tag, marker) => {
    const d = path.join(tmp, tag);
    mkdirSync(path.join(d, "bridge"), { recursive: true });
    const entry = path.join(d, "bridge", "main.js");
    writeFileSync(entry, "setInterval(()=>{},1000);\n", "utf8");
    const args = [entry];
    if (marker) args.push(`--state-dir=${marker}`);
    const child = spawn(process.execPath, args, { stdio: "ignore" });
    children.push({ child, logPath: path.join(d, "fake.log"), tag, exited: null });
    return child;
  };
  const sameIdentity = fakeBridge("scansame", dir);
  const otherIdentity = fakeBridge("scanother", path.join(tmp, "elsewhere"));
  const legacy = fakeBridge("scanlegacy", null);
  await sleep(1000);

  const procs = scanBridgeProcs(dir).procs;
  const byPid = (pid) => procs.find((p) => p.pid === pid);
  ok("同身份假桥被识别为 own", byPid(sameIdentity.pid)?.own === true);
  ok("不同身份假桥被识别为 otherNew（有标记但非本目录）", byPid(otherIdentity.pid)?.hasMarker === true && byPid(otherIdentity.pid)?.own === false);
  ok("无标记假桥被归类为 legacy", byPid(legacy.pid)?.hasMarker === false);

  // includeLegacy=false：只清"同一身份"，绝不碰其它身份（也不会误伤开发机上的生产桥）
  const res = killOtherBridges({ stateDir: dir, includeLegacy: false, log: () => {} });
  await waitFor(() => sameIdentity.exitCode !== null || sameIdentity.killed, { timeout: 3000 });
  ok("同身份假桥被清掉", res.killed.includes(sameIdentity.pid), `killed=[${res.killed.join(",")}]`);
  ok("不同身份假桥未被清（skipped）", res.skipped.includes(otherIdentity.pid) && !res.killed.includes(otherIdentity.pid));
  ok("legacy 假桥未被清（includeLegacy=false 时不碰）", res.skipped.includes(legacy.pid) && !res.killed.includes(legacy.pid));
  for (const c of [sameIdentity, otherIdentity, legacy]) { try { c.kill(); } catch { /* 已退出 */ } }
}

// ---------- 清理 ----------
for (const c of children) { try { c.child.kill(); } catch { /* 已退出 */ } }
await sleep(300);
try { rmSync(tmp, { recursive: true, force: true }); } catch { /* 占用中忽略 */ }

log(`\n=== 结果：${pass} 通过 / ${fail} 失败 ===`);
process.exit(fail === 0 ? 0 : 1);
