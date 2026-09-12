// smoke-dsh-v2.mjs：仿新版 DSH（v0.1.5+）服务器，验证桥的鉴权 + unary + remote.mux 流 + 适配映射。
// 覆盖：token→Cookie 换发/缓存/401 重铸、session/list、session/page(throughSeq)、$events 审批/提问应答、
//       workspace/follow 基线、session/follow 事件、session/control 队列、老版无鉴权直连。
import { createServer } from "node:http";
import { createHash, randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DshClient } from "../bridge/dsh.js";
import { Adapter } from "../bridge/adapter.js";

const TOKEN = "test-token-123";
const COOKIE_VALUE = `v1.${Buffer.from('{"version":1,"authority":"x","issuedAt":1,"expiresAt":9999999999999}').toString("base64url")}.ZmFrZQ`;
const stateDir = mkdtempSync(join(tmpdir(), "dshmobile-smoke-"));
const PORT = 17_599;

// ---- 服务器状态/断言 ----
const seen = {
  tokenExchanges: 0,
  cookieRejected: false,      // 置 true 后第一次带 Cookie 请求回 401（测重铸）
  pageArgs: null,
  listArgs: null,
  eventResultArgs: [],
  wsUpgradeCookie: null,
  requireCookie: true,        // 老版模式测试时置 false
  openFrames: [],
  wsSockets: new Set(),
};

function authority() { return `127.0.0.1:${PORT}`; }
const cookieName = `dsh-auth-${Buffer.from(authority()).toString("base64url")}`;
function hasAuth(req) {
  const c = req.headers.cookie ?? "";
  return c.split(";").some((p) => p.trim().startsWith(`${cookieName}=`));
}

function okResponse(rpcId, value) {
  return { type: "server-response", rpcId, result: { ok: true, value } };
}
function errResponse(rpcId, code, message) {
  return { type: "server-response", rpcId, result: { ok: false, error: { code, message, details: {} } } };
}

async function readBody(req) {
  let raw = "";
  for await (const c of req) raw += c;
  return raw ? JSON.parse(raw) : null;
}

// ---- WS 帧编解码 ----
function acceptKey(key) {
  return createHash("sha1").update(key + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11").digest("base64");
}
function encodeFrame(payload) {
  const buf = Buffer.from(payload, "utf8");
  if (buf.length < 126) return Buffer.concat([Buffer.from([0x81, buf.length]), buf]);
  if (buf.length < 65536) {
    const h = Buffer.alloc(4);
    h[0] = 0x81; h[1] = 126; h.writeUInt16BE(buf.length, 2);
    return Buffer.concat([h, buf]);
  }
  const h = Buffer.alloc(10);
  h[0] = 0x81; h[1] = 127; h.writeBigUInt64BE(BigInt(buf.length), 2);
  return Buffer.concat([h, buf]);
}

const server = createServer((req, res) => {
  const url = new URL(req.url, `http://127.0.0.1:${PORT}`);
  if (req.method === "GET" && url.pathname === "/") {
    if (url.searchParams.get("token") === TOKEN) {
      seen.tokenExchanges += 1;
      res.writeHead(303, {
        location: "/",
        "set-cookie": `${cookieName}=${COOKIE_VALUE}; Path=/; Max-Age=2592000; HttpOnly; SameSite=Strict`,
      });
      res.end();
    } else {
      res.writeHead(401, { "content-type": "text/plain" });
      res.end("dsh web authentication required");
    }
    return;
  }
  if (req.method === "POST" && url.pathname.startsWith("/api/")) {
    if (seen.requireCookie && !hasAuth(req)) {
      res.writeHead(401, { "content-type": "text/plain" });
      res.end("unauthorized");
      return;
    }
    if (seen.requireCookie && seen.cookieRejected) {
      seen.cookieRejected = false;
      res.writeHead(401, { "content-type": "text/plain" });
      res.end("unauthorized");
      return;
    }
    readBody(req).then((body) => {
      const endpoint = url.pathname.slice(5);
      if (body?.type !== "client-request" || body.method !== endpoint) {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify(errResponse(body?.rpcId ?? "x", "gateway/bad-request", "envelope mismatch")));
        return;
      }
      const value = (() => {
        switch (endpoint) {
          case "session/list": {
            seen.listArgs = body.payload.args;
            return { items: [{ sessionId: "sess-1", updatedAt: Date.now(), running: false, blank: false, cwd: "D:\\p", projections: { values: { title: "测试会话" } } }] };
          }
          case "session/page": {
            seen.pageArgs = body.payload.args;
            return {
              records: [
                { type: "event", event: { type: "user/message", seq: 2, time: Date.now(), data: {} } },
                { type: "event", event: { type: "assistant/message", seq: 3, time: Date.now(), data: {} } },
                { type: "event", event: { type: "assistant/chunk", seq: 4, time: Date.now(), data: {} } },
                { type: "event", event: { type: "tool/result", seq: 5, time: Date.now(), data: { message: { content: [{ type: "text", text: "y".repeat(600) }] } } } },
              ],
              hasMore: false,
            };
          }
          case "session/modelCatalog":
            return { default: { provider: "deepseek", model: "v4" }, routableProviders: ["deepseek"], groups: [], failures: [] };
          case "session/create": return { sessionId: "sess-new" };
          case "session/prompt": return { accepted: true };
          case "session/rename": return { title: body.payload.args.request.title, seq: 1 };
          case "session/fork": return { sessionId: "fork-1" };
          case "session/cancel": return { accepted: true };
          case "session/updateQueue": return { accepted: true };
          case "session/selectModel": return { selected: { provider: body.payload.args.request.provider, model: body.payload.args.request.model } };
          case "session/attachment": return { attachment: { attachmentId: "a1", mediaType: "image/png", bytes: 4, width: 1, height: 1 }, data: "aGVsbG8=" };
          case "commands/list": return [{ name: "/plan", description: "plan" }];
          case "commands/execute": return { commandId: "c1", result: { kind: "success", text: "ok" } };
          case "workspace/create": return { workspace: { workspaceId: "ws-1", path: "D:\\p", title: "p", sessionIds: [], createdAt: "", updatedAt: "" }, created: true };
          case "workspace/delete": return { deleted: true };
          case "workspace/archiveSession": return { archivedSessionIds: ["arch-1"] };
          case "$events/result": {
            seen.eventResultArgs.push(body.payload.args);
            return undefined;
          }
          default:
            return undefined;
        }
      })();
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(okResponse(body.rpcId, value)));
    }).catch((err) => {
      res.writeHead(500, { "content-type": "text/plain" });
      res.end(String(err));
    });
    return;
  }
  res.writeHead(404);
  res.end();
});

server.on("upgrade", (req, socket) => {
  const url = new URL(req.url, "http://x");
  if (url.pathname !== "/api/remote.mux") { socket.end("HTTP/1.1 404 Not Found\r\n\r\n"); return; }
  if (seen.requireCookie && !hasAuth(req)) {
    seen.wsUpgradeCookie = null;
    socket.end("HTTP/1.1 401 Unauthorized\r\nConnection: close\r\nContent-Length: 12\r\n\r\nunauthorized");
    return;
  }
  seen.wsUpgradeCookie = req.headers.cookie ?? null;
  const key = req.headers["sec-websocket-key"];
  socket.write([
    "HTTP/1.1 101 Switching Protocols",
    "Upgrade: websocket",
    "Connection: Upgrade",
    `Sec-WebSocket-Accept: ${acceptKey(key)}`,
    "", "",
  ].join("\r\n"));
  seen.wsSockets.add(socket);
  socket.on("close", () => seen.wsSockets.delete(socket));

  let pending = Buffer.alloc(0);
  socket.on("data", (chunk) => {
    pending = Buffer.concat([pending, chunk]);
    while (pending.length >= 2) {
      const b0 = pending[0], b1 = pending[1];
      const len = b1 & 0x7f;
      let offset = 2;
      let plen = len;
      if (len === 126) { if (pending.length < 4) return; plen = pending.readUInt16BE(2); offset = 4; }
      else if (len === 127) { if (pending.length < 10) return; plen = Number(pending.readBigUInt64BE(2)); offset = 10; }
      const masked = (b1 & 0x80) !== 0;
      const maskLen = masked ? 4 : 0;
      if (pending.length < offset + maskLen + plen) return;
      const mask = masked ? pending.subarray(offset, offset + 4) : null;
      const payload = Buffer.from(pending.subarray(offset + maskLen, offset + maskLen + plen));
      if (mask) for (let i = 0; i < payload.length; i++) payload[i] ^= mask[i % 4];
      pending = pending.subarray(offset + maskLen + plen);
      const opcode = b0 & 0x0f;
      if (opcode === 0x8) { socket.end(); return; } // close
      if (opcode === 0x1) {
        const msg = JSON.parse(payload.toString("utf8"));
        seen.openFrames.push(msg);
        if (msg.type === "open") {
          if (msg.endpoint === "$events") {
            socket.write(encodeFrame(JSON.stringify({ type: "item", streamId: msg.streamId, value: { type: "ready", clientId: "cli-1", host: { home: "D:\\p" } } })));
            socket.write(encodeFrame(JSON.stringify({ type: "item", streamId: msg.streamId, value: { type: "waterfall", event: "approval/request", eventId: "evt-1", agentId: "sess-1", request: { toolName: "WriteFile", reason: "测试审批" } } })));
            socket.write(encodeFrame(JSON.stringify({ type: "item", streamId: msg.streamId, value: { type: "waterfall", event: "user-questions/request", eventId: "evt-2", agentId: "sess-1", request: { questions: [{ id: "q1", question: "怎么做?", options: [{ label: "A" }, { label: "B" }] }] } } })));
            socket.write(encodeFrame(JSON.stringify({ type: "item", streamId: msg.streamId, value: { type: "emit", event: "api-session/added", args: [{ sessionId: "sess-9", cwd: "D:\\p", updatedAt: 1, running: false, blank: false }] } })));
          } else if (msg.endpoint === "session/control") {
            socket.write(encodeFrame(JSON.stringify({ type: "item", streamId: msg.streamId, value: { type: "baseline", value: { queues: { "sess-1": [{ id: "q1", placement: "queued", message: { id: "q1", content: [{ type: "text", text: "hi" }] } }] }, jobs: {}, projections: {} } } })));
          } else if (msg.endpoint === "workspace/follow") {
            socket.write(encodeFrame(JSON.stringify({ type: "item", streamId: msg.streamId, value: { type: "baseline", value: { items: [{ workspaceId: "ws-1", path: "D:\\p", title: "p", sessionIds: ["sess-1"], createdAt: "", updatedAt: "" }], archivedSessionIds: ["arch-1"] } } })));
          } else if (msg.endpoint === "session/follow") {
            const sid = msg.payload?.args?.request?.address?.sessionId;
            socket.write(encodeFrame(JSON.stringify({ type: "item", streamId: msg.streamId, value: { type: "snapshot", header: { version: 1, id: sid, createdAt: 1, isSeeded: false }, cursor: 5, records: [], hasMore: false, projections: { asOfSeq: 5, values: { title: "测试会话" } } } })));
            socket.write(encodeFrame(JSON.stringify({ type: "item", streamId: msg.streamId, value: { type: "event", event: { type: "turn/start", seq: 6, time: Date.now(), data: { turn: 1 } } } })));
            socket.write(encodeFrame(JSON.stringify({ type: "item", streamId: msg.streamId, value: { type: "event", event: { type: "assistant/message", seq: 7, time: Date.now(), data: {} } } })));
            socket.write(encodeFrame(JSON.stringify({ type: "item", streamId: msg.streamId, value: { type: "event", event: { type: "turn/end", seq: 8, time: Date.now(), data: { turn: 1, reason: "stop" } } } })));
          }
        }
      }
    }
  });
});

// ---- 测试驱动 ----
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let failures = 0;
function check(name, cond, extra = "") {
  if (cond) console.log(`  PASS ${name}`);
  else { failures += 1; console.log(`  FAIL ${name} ${extra}`); }
}

const relayResponses = [];
const relayEvents = [];
const fakeRelay = {
  url: "http://127.0.0.1:1",
  respond(requestId, type, payload) { relayResponses.push({ requestId, type, payload }); },
  forwardEvent(ev) { relayEvents.push(ev); },
};

await new Promise((r) => server.listen(PORT, "127.0.0.1", r));
try {
  const base = `http://127.0.0.1:${PORT}`;

  console.log("[1] 鉴权：token 换 Cookie + unary 带 Cookie");
  const dsh = new DshClient(base, { stateDir, token: TOKEN });
  const list = await dsh.unary("session/list", { _request: {} });
  check("session/list ok", list.ok === true && list.value?.items?.[0]?.sessionId === "sess-1", JSON.stringify(list.error ?? list));
  check("list args 形状 {_request:{}}", JSON.stringify(seen.listArgs) === JSON.stringify({ _request: {} }), JSON.stringify(seen.listArgs));
  check("token 换发发生 1 次", seen.tokenExchanges === 1, `count=${seen.tokenExchanges}`);

  console.log("[2] Cookie 缓存：第二个客户端复用缓存不重换 token");
  const dsh2 = new DshClient(base, { stateDir, token: TOKEN });
  const list2 = await dsh2.unary("session/list", { _request: {} });
  check("缓存 Cookie 可用", list2.ok === true);
  check("未重复 token 换发", seen.tokenExchanges === 1, `count=${seen.tokenExchanges}`);

  console.log("[3] 401 → 作废缓存并重铸");
  seen.cookieRejected = true;
  const list3 = await dsh2.unary("session/list", { _request: {} });
  check("401 后重铸成功", list3.ok === true, JSON.stringify(list3));
  check("token 换发第 2 次", seen.tokenExchanges === 2, `count=${seen.tokenExchanges}`);

  console.log("[4] 适配器：attachMux + sessions.list（workspace 基线 + 标题投影 + 绿点）");
  const adapter = new Adapter({ dsh: dsh2, relay: fakeRelay, workspaceRoot: join(stateDir, "deliveries"), e2ee: null });
  let muxClosed = false;
  const mux = dsh2.openMux(() => { muxClosed = true; });
  adapter.attachMux(mux);
  await sleep(300); // 等 $events ready + 各流基线

  await adapter.handleRequest({ requestId: "r1", type: "sessions.list", payload: {} });
  const r1 = relayResponses.find((r) => r.requestId === "r1");
  check("sessions.list ok", r1?.payload?.ok === true, JSON.stringify(r1?.payload));
  check("标题投影 title=测试会话", r1?.payload?.data?.sessions?.[0]?.title === "测试会话");
  check("归档集合来自 workspace 基线", JSON.stringify(r1?.payload?.data?.archivedSessionIds) === JSON.stringify(["arch-1"]), JSON.stringify(r1?.payload?.data?.archivedSessionIds));

  console.log("[5] sessions.history → session/page（throughSeq=follow cursor）");
  await adapter.handleRequest({ requestId: "r2", type: "sessions.history", payload: { sessionId: "sess-1" } });
  const r2 = relayResponses.find((r) => r.requestId === "r2");
  check("history ok", r2?.payload?.ok === true, JSON.stringify(r2?.payload));
  check("page throughSeq=最新游标(8)", seen.pageArgs?.request?.throughSeq === 8, JSON.stringify(seen.pageArgs));
  check("chunk 被剥离", (r2?.payload?.data?.events ?? []).every((e) => e.event.type !== "assistant/chunk"));
  check("tool/result 截断 ≤510", (r2?.payload?.data?.events ?? []).find((e) => e.event.type === "tool/result")?.event.data.message.content[0].text.length <= 510);
  check("projections 透传", r2?.payload?.data?.projections?.values?.title === "测试会话");

  console.log("[6] $events：审批/提问瀑布 → 转发 + $events/result 应答");
  await sleep(200);
  const approvalEvt = relayEvents.find((e) => e.rpcId === "evt-1");
  check("approval/requested 转发（eventId 充当 id/approvalId + 帧内 sessionId）", approvalEvt?.frame?.type === "approval/requested" && approvalEvt.frame.id === "evt-1" && approvalEvt.frame.approvalId === "evt-1" && approvalEvt.frame.toolName === "WriteFile" && approvalEvt.frame.sessionId === "sess-1", JSON.stringify(approvalEvt));
  const questionEvt = relayEvents.find((e) => e.rpcId === "evt-2");
  check("question/requested 转发（帧内 sessionId）", questionEvt?.frame?.type === "question/requested" && questionEvt.frame.questions?.[0]?.id === "q1" && questionEvt.frame.sessionId === "sess-1", JSON.stringify(questionEvt));
  check("host/session-added 广播", relayEvents.some((e) => e.frame?.type === "host/session-added" && e.frame.sessionId === "sess-9"));

  await adapter.handleRequest({ requestId: "r3", type: "approvals.respond", payload: { rpcId: "evt-1", outcome: "allowed-once", sessionId: "sess-1" } });
  check("approvals.respond ok", relayResponses.find((r) => r.requestId === "r3")?.payload?.ok === true);
  const ar = seen.eventResultArgs.find((a) => a.eventId === "evt-1");
  check("$events/result outcome=allowed-once", ar?.outcome?.kind === "result" && ar.outcome.value === "allowed-once" && ar.clientId === "cli-1", JSON.stringify(ar));

  await adapter.handleRequest({ requestId: "r4", type: "questions.respond", payload: { rpcId: "evt-2", cancel: true, sessionId: "sess-1" } });
  const qr = seen.eventResultArgs.find((a) => a.eventId === "evt-2");
  check("questions cancel → 全空答案", JSON.stringify(qr?.outcome?.value) === JSON.stringify({ answers: [{ id: "q1", selected: [] }] }), JSON.stringify(qr));

  console.log("[7] session/follow 事件 → session/event 转发 + 绿点 + 游标推进");
  await sleep(300);
  check("session/event 转发", relayEvents.some((e) => e.frame?.type === "session/event" && e.frame.sessionId === "sess-1" && e.frame.event?.type === "assistant/message"));
  await adapter.handleRequest({ requestId: "r5", type: "sessions.list", payload: {} });
  const r5 = relayResponses.find((r) => r.requestId === "r5");
  check("绿点 completedSessionIds 含 sess-1", r5?.payload?.data?.completedSessionIds?.includes("sess-1"), JSON.stringify(r5?.payload?.data?.completedSessionIds));
  // 回归：live 事件后历史请求必须用最新游标（seq=8），否则手机刷新只能看到旧对话
  await adapter.handleRequest({ requestId: "r5b", type: "sessions.history", payload: { sessionId: "sess-1" } });
  check("live 事件推进游标 → history throughSeq=8", seen.pageArgs?.request?.throughSeq === 8, JSON.stringify(seen.pageArgs));

  console.log("[8] session/control 队列 + workspace.list + 其余端点映射");
  check("session/queue 转发", relayEvents.some((e) => e.frame?.type === "session/queue" && e.frame.sessionId === "sess-1"));
  await adapter.handleRequest({ requestId: "r6", type: "workspace.list", payload: {} });
  const r6 = relayResponses.find((r) => r.requestId === "r6");
  check("workspace.list 基线", r6?.payload?.ok === true && r6.payload.data.items?.[0]?.workspaceId === "ws-1", JSON.stringify(r6?.payload));
  await adapter.handleRequest({ requestId: "r7", type: "sessions.run", payload: { sessionId: "sess-1", content: [{ type: "text", text: "hi" }] } });
  check("sessions.run ok", relayResponses.find((r) => r.requestId === "r7")?.payload?.ok === true);
  await adapter.handleRequest({ requestId: "r8", type: "sessions.create", payload: { cwd: "D:\\p" } });
  check("sessions.create ok(workspace/create+session/create)", relayResponses.find((r) => r.requestId === "r8")?.payload?.ok === true);
  await adapter.handleRequest({ requestId: "r9", type: "session.models", payload: { sessionId: "sess-1" } });
  check("session.models → modelCatalog", relayResponses.find((r) => r.requestId === "r9")?.payload?.ok === true);
  await adapter.handleRequest({ requestId: "r10", type: "sessions.updateQueue", payload: { sessionId: "sess-1", itemId: "q1", action: { kind: "edit", content: [{ type: "text", text: "x" }] } } });
  check("sessions.updateQueue ok", relayResponses.find((r) => r.requestId === "r10")?.payload?.ok === true);
  await adapter.handleRequest({ requestId: "r11", type: "sessions.interrupt", payload: { sessionId: "sess-1" } });
  check("sessions.interrupt ok", relayResponses.find((r) => r.requestId === "r11")?.payload?.ok === true);

  console.log("[9] 老版 DSH 无鉴权直连（无 token 不带 Cookie）");
  seen.requireCookie = false;
  const dshOld = new DshClient(base, { stateDir: join(stateDir, "old"), token: "" });
  const oldList = await dshOld.unary("session/list", { _request: {} });
  check("无 token 直连 ok", oldList.ok === true, JSON.stringify(oldList));
  seen.requireCookie = true;

  console.log("[9b] subagent 会话地址映射（origin=subagent → 带父会话/模式地址）");
  adapter.sessionMeta.set("sub-1", {
    sessionId: "sub-1",
    origin: "subagent",
    parentSessionId: "parent-1",
    projections: { values: { subagent: { mode: "continuable", seq: 0 } } },
  });
  await adapter.handleRequest({ requestId: "r12", type: "sessions.history", payload: { sessionId: "sub-1" } });
  check("subagent 会话 page 地址正确", seen.pageArgs?.request?.address?.kind === "subagent" && seen.pageArgs.request.address.parentSessionId === "parent-1" && seen.pageArgs.request.address.mode === "continuable", JSON.stringify(seen.pageArgs));
  adapter.sessionMeta.delete("sub-1");

  console.log("[10] WS 升级携带 Cookie");
  check("mux upgrade 带 Cookie", typeof seen.wsUpgradeCookie === "string" && seen.wsUpgradeCookie.includes(cookieName), String(seen.wsUpgradeCookie));
  check("mux 收到 open 帧($events/session/follow…)", seen.openFrames.some((f) => f.endpoint === "$events") && seen.openFrames.some((f) => f.endpoint === "session/follow"), seen.openFrames.map((f) => f.endpoint).join(","));

  mux.close();
  console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILURES`);
} finally {
  for (const s of seen.wsSockets) { try { s.destroy(); } catch {} }
  server.close();
  rmSync(stateDir, { recursive: true, force: true });
}
process.exit(failures === 0 ? 0 : 1);
