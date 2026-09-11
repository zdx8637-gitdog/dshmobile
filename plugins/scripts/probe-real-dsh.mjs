// probe-real-dsh.mjs：只读验证——用本机 credentials 里的持久化签名密钥锻造合法 Cookie，
// 对运行中的真实 DSH (127.0.0.1:3080) 调用 session/list 等，确认桥的 wire 形状在真实服务端成立。
// 安全：不打印 secret/token/cookie 值，只输出状态与结果形状。
import { createHash, createHmac, randomUUID } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const b64url = (buf) => Buffer.from(buf).toString("base64").replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/u, "");

/** 从 credentials yaml 里提取 browser-session 记录的 secret（行式解析，不整体打印文件）。 */
function readBrowserSecret(candidates) {
  for (const file of candidates) {
    if (!existsSync(file)) continue;
    let lines;
    try { lines = readFileSync(file, "utf8").split(/\r?\n/); } catch { continue; }
    let inRecord = false;
    for (const line of lines) {
      if (/client-connection[^\n]*browser-session|browser-session[^\n]*client-connection/.test(line)) inRecord = true;
      else if (inRecord && /^\S/.test(line) && !/^\s/.test(line) && !/secret|payload|kind|version/.test(line)) inRecord = false;
      if (inRecord) {
        const m = /^\s*secret:\s*"?([A-Za-z0-9_-]{30,})"?\s*$/.exec(line);
        if (m) return { file, secret: m[1] };
      }
    }
  }
  return null;
}

const home = homedir();
const found = readBrowserSecret([
  join(home, ".dsh", ".credentials.yaml"),
  join(home, ".dsh", "profiles", "web", ".credentials.yaml"),
]);
if (!found) {
  console.log("SKIP: no client-connection/browser-session record found (浏览器可能还没完成过一次登录换 Cookie)");
  process.exit(0);
}
console.log(`credentials record found in ${found.file} (secret not printed)`);

const AUTHORITY = "127.0.0.1:3080";
const cookieName = "dsh-auth-" + b64url(createHash("sha256").update(AUTHORITY).digest());
const issuedAt = Date.now();
const expiresAt = issuedAt + 24 * 3600e3;
const body = b64url(Buffer.from(JSON.stringify({ version: 1, authority: AUTHORITY, issuedAt, expiresAt }), "utf8"));
const signature = b64url(createHmac("sha256", Buffer.from(found.secret, "base64url")).update(body).digest());
const cookie = `${cookieName}=v1.${body}.${signature}`;

const base = `http://${AUTHORITY}`;
const headers = { cookie, "content-type": "application/json" };
let failures = 0;
const check = (n, c, e = "") => {
  if (c) console.log("  PASS", n);
  else { failures += 1; console.log("  FAIL", n, e); }
};

console.log("[1] GET / 带锻造 Cookie（应 200 而非 401）");
const idx = await fetch(`${base}/`, { headers: { cookie } });
check("GET / → 200", idx.status === 200, `status=${idx.status}`);
if (idx.status !== 200) {
  console.log("真实 DSH 拒绝了锻造 Cookie——终止后续检查");
  process.exit(1);
}

console.log("[2] POST /api/session/list");
async function unary(endpoint, args) {
  const rpcId = randomUUID();
  const res = await fetch(`${base}/api/${endpoint}`, {
    method: "POST",
    headers,
    body: JSON.stringify({ type: "client-request", rpcId, method: endpoint, payload: { args } }),
  });
  const bodyJson = await res.json().catch(() => ({}));
  return { status: res.status, body: bodyJson };
}
const list = await unary("session/list", { _request: {} });
check("session/list HTTP 200", list.status === 200, `status=${list.status}`);
check("server-response ok:true", list.body?.type === "server-response" && list.body?.result?.ok === true, JSON.stringify(list.body?.result?.error ?? list.body).slice(0, 300));
const items = list.body?.result?.value?.items ?? [];
console.log(`    会话数 = ${items.length}`, items.slice(0, 3).map((s) => `${s.sessionId}(cwd=${s.cwd ?? "-"},title=${s.projections?.values?.title ?? "-"})`).join(" | "));

console.log("[3] POST /api/session/modelCatalog");
const cat = await unary("session/modelCatalog", {});
check("modelCatalog ok", cat.body?.result?.ok === true, JSON.stringify(cat.body?.result?.error ?? cat.body).slice(0, 200));
console.log(`    default=${cat.body?.result?.value?.default?.provider}/${cat.body?.result?.value?.default?.model}, groups=${cat.body?.result?.value?.groups?.length ?? 0}`);

console.log("[4] 真实会话 session/page（throughSeq=-1 空页 vs cursor 真实游标）");
if (items.length > 0) {
  const sid = items[0].sessionId;
  const empty = await unary("session/page", { request: { address: { kind: "session", sessionId: sid }, throughSeq: -1, maxMessages: 10 } });
  console.log(`    throughSeq=-1 → records=${empty.body?.result?.value?.records?.length ?? "-"}`);
  // 从 follow 流拿 cursor 需要 WS；这里直接用一个足够大的假游标验证错误语义即可——真正路径桥已用 follow cursor。
  const big = await unary("session/page", { request: { address: { kind: "session", sessionId: sid }, throughSeq: 999999999, maxMessages: 10 } });
  console.log(`    throughSeq=999999999 → ${big.body?.result?.ok === false ? `错误码=${big.body.result.error?.code}` : `records=${big.body?.result?.value?.records?.length}`}`);
}

console.log("[5] workspace/follow + $events 需要 WS——用一次真实升级验证 Cookie 通过 WS 鉴权");
const wsCookieOk = await new Promise((resolve) => {
  let done = false;
  const finish = (v) => { if (!done) { done = true; resolve(v); } };
  const ws = new WebSocket(`ws://${AUTHORITY}/api/remote.mux`, { headers: { cookie } });
  const t = setTimeout(() => { try { ws.close(); } catch {} finish("timeout"); }, 4000);
  ws.onopen = () => { clearTimeout(t); try { ws.close(); } catch {} finish("open"); };
  ws.onerror = () => { clearTimeout(t); finish("error"); };
});
check("remote.mux WS 升级成功（带 Cookie）", wsCookieOk === "open", `result=${wsCookieOk}`);

console.log("[6] 真实 mux 流：$events ready / workspace/follow 基线 / session/follow cursor → page");
const streamItems = { events: [], workspace: [], follow: new Map() };
const ws2 = new WebSocket(`ws://${AUTHORITY}/api/remote.mux`, { headers: { cookie } });
const target = items.find((s) => s.origin !== "subagent") ?? items[0];
const openStream = (endpoint, args) => {
  ws2.send(JSON.stringify({ type: "open", streamId: randomUUID(), endpoint, payload: { args } }));
};
ws2.onmessage = (ev) => {
  const f = JSON.parse(ev.data);
  if (f.type === "error") { console.log("    流错误帧:", f.error?.code, f.error?.message ?? ""); return; }
  if (f.type !== "item" || f.value == null) return;
  if (f.value.type === "ready") streamItems.events.push(f.value);
  if (f.value.type === "baseline") streamItems.workspace.push(f.value);
  if (f.value.type === "snapshot" && f.value.header) streamItems.follow.set(f.value.header.id, f.value);
};
await new Promise((resolve) => {
  ws2.onopen = () => {
    openStream("$events", {});
    openStream("workspace/follow", {});
    if (target) {
      openStream("session/follow", { request: { address: { kind: "session", sessionId: target.sessionId } } });
    }
  };
  const t = setTimeout(resolve, 6000);
  const poll = setInterval(() => {
    if (streamItems.events.length > 0 && streamItems.workspace.length > 0 && (!target || streamItems.follow.has(target.sessionId))) {
      clearInterval(t); clearInterval(poll); resolve();
    }
  }, 100);
});
check("$events ready 收到 clientId", streamItems.events.length === 1 && typeof streamItems.events[0].clientId === "string");
const wb = streamItems.workspace[0];
check("workspace/follow 基线", wb?.value?.items?.length > 0, `workspaces=${wb?.value?.items?.length ?? 0}`);
if (target) {
  console.log(`    目标会话 ${target.sessionId} (origin=${target.origin ?? "session"})`);
  const snap = streamItems.follow.get(target.sessionId);
  check("session/follow snapshot cursor", Number.isInteger(snap?.cursor), `cursor=${snap?.cursor}`);
  if (Number.isInteger(snap?.cursor)) {
    const page = await unary("session/page", { request: { address: { kind: "session", sessionId: target.sessionId }, throughSeq: snap.cursor, maxMessages: 10 } });
    check("真实 cursor → page 返回记录", page.body?.result?.ok === true && (page.body.result.value?.records?.length ?? 0) > 0, `records=${page.body?.result?.value?.records?.length ?? "-"}`);
    console.log(`    最近 ${page.body?.result?.value?.records?.length ?? 0} 条事件（含消息对齐切片）`);
  }
}
try { ws2.close(); } catch {}

console.log(failures === 0 ? "\nALL PASS（真实 DSH 接受桥的鉴权与 wire 形状）" : `\n${failures} FAILURES`);
process.exit(failures === 0 ? 0 : 1);
