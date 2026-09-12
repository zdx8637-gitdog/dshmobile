// smoke-dsh-legacy.mjs：仿老版 DSH（点号端点 + 裸 payload + events.mux/host 双 WS + respond），
// 验证桥的 legacy 协议路径：探测不误判、unary 形状、审批/提问 respond、历史压缩、事件转发。
import { createServer } from "node:http";
import { createHash, randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DshClient } from "../bridge/dsh.js";
import { Adapter } from "../bridge/adapter.js";

const stateDir = mkdtempSync(join(tmpdir(), "dshmobile-legacy-"));
const PORT = 17_598;

const seen = {
  unaryBodies: [],     // {path, method, payload}
  responds: [],        // {rpcId, result}
  promptFailsLeft: 1,  // session.prompt 前 N 次回 session-not-found（测重建重试）
};
const WS_CLIENTS = new Set();

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

// ---- WS 帧编解码（与 smoke-dsh-v2 相同的最小实现）----
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
function wireSocket(socket) {
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
      if ((b0 & 0x0f) === 0x8) { socket.end(); return; }
      // 客户端可能发心跳/无关帧：忽略
    }
  });
}

function pushFrame(socket, obj) {
  if (socket.readyState === "open") socket.write(encodeFrame(JSON.stringify(obj)));
}

const server = createServer((req, res) => {
  const url = new URL(req.url, `http://127.0.0.1:${PORT}`);
  if (req.method === "POST" && url.pathname.startsWith("/api/")) {
    readBody(req).then((body) => {
      const path = url.pathname.slice(5);
      const respondJson = (v) => { res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify(v)); };
      if (path === "respond") {
        seen.responds.push({ rpcId: body?.rpcId, result: body?.result });
        respondJson({ accepted: true });
        return;
      }
      if (body?.type !== "client-request") { respondJson(errResponse(body?.rpcId ?? "x", "bad-request", "not client-request")); return; }
      seen.unaryBodies.push({ path, method: body.method, payload: body.payload });
      const method = body.method;
      let value;
      let err = null;
      if (method === "session.prompt" && seen.promptFailsLeft > 0) {
        seen.promptFailsLeft -= 1;
        err = { code: "session-not-found", message: "session not found (simulated)" };
      } else {
        switch (method) {
          case "session.list": value = { items: [{ sessionId: "sess-1", cwd: "D:\\p", updatedAt: Date.now(), running: false }] }; break;
          case "workspace.list": value = { items: [{ workspaceId: "ws-1", path: "D:\\p", title: "p" }], archivedSessionIds: ["arch-1"] }; break;
          case "session.history": value = {
            events: [
              { seq: 2, event: { type: "user/message", data: { content: [{ type: "text", text: "你好" }] } } },
              { seq: 3, event: { type: "assistant/message", data: { content: [{ type: "text", text: "回复" }] } } },
              { seq: 4, event: { type: "assistant/chunk", data: {} } },
              { seq: 5, event: { type: "tool/result", data: { message: { content: [{ type: "text", text: "y".repeat(600) }] } } } },
            ],
            hasMore: false,
            projections: { sessionStats: { tokens: 100 } },
          };
          break;
          case "session.models": value = { default: { provider: "deepseek", model: "v3" } }; break;
          case "session.prompt": value = { accepted: true }; break;
          case "commands/list": value = [{ name: "/plan", description: "plan" }]; break;
          case "session.create": value = { sessionId: "sess-new" }; break;
          case "session.rename": value = { title: body.payload.title, seq: 1 }; break;
          case "session.fork": value = { sessionId: "fork-1" }; break;
          case "session.cancel": value = { accepted: true }; break;
          case "session.updateQueue": value = { accepted: true }; break;
          case "session.selectModel": value = { selected: { provider: body.payload.provider, model: body.payload.model } }; break;
          case "session.attachment": value = { attachment: { attachmentId: "a1", mediaType: "image/png", bytes: 4, width: 1, height: 1 }, data: "aGVsbG8=" }; break;
          case "commands/execute": value = { commandId: "c1", result: { kind: "success", text: "ok" } }; break;
          case "workspace.create": value = { workspace: { workspaceId: "ws-1", path: "D:\\p", title: "p" }, created: true }; break;
          case "workspace.delete": value = { deleted: true }; break;
          case "workspace.archiveSession": value = { archivedSessionIds: ["arch-1"] }; break;
          default: err = { code: "unknown-method", message: `unknown method ${method}` };
        }
      }
      respondJson(err ? errResponse(body.rpcId, err.code, err.message) : okResponse(body.rpcId, value));
    }).catch((e) => {
      res.writeHead(500); res.end(String(e));
    });
    return;
  }
  res.writeHead(404);
  res.end();
});

server.on("upgrade", (req, socket) => {
  const url = new URL(req.url, "http://x");
  if (url.pathname !== "/api/events.mux" && url.pathname !== "/api/events.host") {
    socket.end("HTTP/1.1 404 Not Found\r\n\r\n");
    return;
  }
  const key = req.headers["sec-websocket-key"];
  socket.write([
    "HTTP/1.1 101 Switching Protocols",
    "Upgrade: websocket",
    "Connection: Upgrade",
    `Sec-WebSocket-Accept: ${acceptKey(key)}`,
    "", "",
  ].join("\r\n"));
  WS_CLIENTS.add(socket);
  socket.on("close", () => WS_CLIENTS.delete(socket));
  wireSocket(socket);
  if (url.pathname === "/api/events.mux") {
    // 老版 DSH mux 帧：server-request {rpcId, payload}
    pushFrame(socket, { type: "server-request", rpcId: "mux-apr", payload: { type: "approval/requested", sessionId: "sess-1", approvalId: "apr-1", toolName: "WriteFile" } });
    pushFrame(socket, { type: "server-request", rpcId: "mux-q", payload: { type: "question/requested", sessionId: "sess-1", questions: [{ id: "q1", question: "怎么做?" }] } });
    pushFrame(socket, { type: "server-request", rpcId: "mux-e1", payload: { type: "session/event", sessionId: "sess-1", event: { type: "turn/start", seq: 6 } } });
    pushFrame(socket, { type: "server-request", rpcId: "mux-e2", payload: { type: "session/event", sessionId: "sess-1", event: { type: "assistant/message", seq: 7 } } });
    pushFrame(socket, { type: "server-request", rpcId: "mux-e3", payload: { type: "session/event", sessionId: "sess-1", event: { type: "turn/end", seq: 8, data: { reason: "stop" } } } });
    pushFrame(socket, { type: "server-request", rpcId: "mux-e4", payload: { type: "session/event", sessionId: "sess-1", event: { type: "assistant/chunk", seq: 9 } } });
    pushFrame(socket, { type: "server-request", rpcId: "mux-qf", payload: { type: "session/queue", sessionId: "sess-1", inbox: { nextTurn: [] } } });
  } else {
    pushFrame(socket, { type: "server-request", rpcId: "host-1", payload: { type: "host/session-added", sessionId: "sess-9" } });
    pushFrame(socket, { type: "server-request", rpcId: "host-2", payload: { type: "host/archived-sessions-changed", archivedSessionIds: ["arch-2"] } });
  }
});

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let failures = 0;
const check = (n, c, e = "") => {
  if (c) console.log("  PASS", n);
  else { failures += 1; console.log("  FAIL", n, e); }
};

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

  console.log("[1] 协议探测：对老版 DSH 应判为 legacy（v2 探针收到 ok:false 错误信封不误判）");
  const dsh = new DshClient(base, { stateDir: join(stateDir, "d"), token: "" });
  const proto = await dsh.ensureProtocol();
  check("探测结果 = legacy", proto === "legacy", String(proto));

  console.log("[2] legacy unary：点号端点 + 裸 payload");
  const list = await dsh.unary("session.list", {});
  check("session.list ok", list.ok === true && list.value?.items?.[0]?.sessionId === "sess-1", JSON.stringify(list));
  const lastList = seen.unaryBodies.filter((b) => b.method === "session.list").at(-1);
  check("payload 裸传（无 {args} 包裹）", JSON.stringify(lastList.payload) === "{}", JSON.stringify(lastList));

  console.log("[3] 适配器：sessions.list / history / 事件转发 / 绿点 / 暂存重放");
  const adapter = new Adapter({ dsh, relay: fakeRelay, workspaceRoot: join(stateDir, "deliveries"), e2ee: null });
  // 连两条 legacy WS（老版 main.js 同款），等帧到达
  const muxWs = dsh.openStream("/api/events.mux", (f) => adapter.handleMuxFrame(f), () => {});
  const hostWs = dsh.openStream("/api/events.host", (f) => adapter.handleHostFrame(f), () => {});
  await sleep(400);
  // host 帧断言要在 sessions.list 之前（list 会按 workspace.list 覆盖 archived）
  check("host 帧转发", relayEvents.some((e) => e.frame?.type === "host/session-added" && e.frame.sessionId === "sess-9"));
  check("host/archived-sessions-changed 更新归档集合", JSON.stringify(adapter.archivedSessionIds) === JSON.stringify(["arch-2"]), JSON.stringify(adapter.archivedSessionIds));

  await adapter.handleRequest({ requestId: "r1", type: "sessions.list", payload: {} });
  const r1 = relayResponses.find((r) => r.requestId === "r1");
  check("sessions.list ok + 归档来自 workspace.list", r1?.payload?.ok === true && JSON.stringify(r1.payload.data.archivedSessionIds) === JSON.stringify(["arch-1"]), JSON.stringify(r1?.payload));

  await adapter.handleRequest({ requestId: "r2", type: "sessions.history", payload: { sessionId: "sess-1" } });
  const r2 = relayResponses.find((r) => r.requestId === "r2");
  const evts = r2?.payload?.data?.events ?? [];
  check("history ok + chunk 剥离 + 截断", r2?.payload?.ok === true && evts.length === 3 && evts.find((e) => e.event.type === "tool/result")?.event.data.message.content[0].text.length <= 510, JSON.stringify(evts.map((e) => e.event.type)));
  check("legacy projections 透传", r2?.payload?.data?.projections?.sessionStats?.tokens === 100);

  check("approval/requested 转发", relayEvents.some((e) => e.rpcId === "mux-apr" && e.frame?.type === "approval/requested"));
  check("question/requested 转发", relayEvents.some((e) => e.rpcId === "mux-q" && e.frame?.type === "question/requested"));
  check("session/event 转发 + chunk 不转发", relayEvents.some((e) => e.frame?.type === "session/event" && e.frame.event?.type === "assistant/message") && !relayEvents.some((e) => e.frame?.type === "session/event" && e.frame.event?.type === "assistant/chunk"));
  check("绿点：turn/end 后 completedSessions 含 sess-1", adapter.completedSessions.has("sess-1"));

  // 暂存重放：无人订阅时 approval 已暂存 → events.subscribe 后重放
  check("pendingRequests 暂存", [...adapter.pendingRequests.keys()].includes("sess-1"));
  await adapter.handleRequest({ requestId: "r3", type: "events.subscribe", payload: { sessionId: "sess-1" } });
  check("subscribe 后重放 approval/requested", relayEvents.some((e) => e.rpcId === "mux-apr" && e.frame?.type === "approval/requested"));

  console.log("[4] 审批/提问应答走 /api/respond");
  await adapter.handleRequest({ requestId: "r4", type: "approvals.respond", payload: { rpcId: "mux-apr", approvalId: "apr-1", outcome: "allowed-once", sessionId: "sess-1" } });
  const rr4 = seen.responds.find((x) => x.rpcId === "mux-apr");
  check("approvals.respond → respond(allowed-once)", rr4?.result?.ok === true && rr4.result.value.outcome === "allowed-once", JSON.stringify(rr4));
  await adapter.handleRequest({ requestId: "r5", type: "questions.respond", payload: { rpcId: "mux-q", cancel: true, sessionId: "sess-1" } });
  const rr5 = seen.responds.find((x) => x.rpcId === "mux-q");
  check("questions.respond cancel → respond(ok:false cancelled)", rr5?.result?.ok === false && rr5.result.error.code === "cancelled", JSON.stringify(rr5));

  console.log("[5] 写路径：run（含 session-not-found 重建）/ create / 斜杠命令");
  seen.promptFailsLeft = 1; // 第一次 session.prompt 回 not-found → 触发 session.create 重建重试
  await adapter.handleRequest({ requestId: "r6", type: "sessions.run", payload: { sessionId: "sess-1", content: [{ type: "text", text: "hi" }] } });
  check("run ok（重建重试后成功）", relayResponses.find((r) => r.requestId === "r6")?.payload?.ok === true);
  const reCreate = seen.unaryBodies.find((b) => b.method === "session.create" && b.payload.sessionId === "sess-1");
  check("重建调用 session.create {sessionId, cwd}", Boolean(reCreate) && reCreate.payload.cwd === "D:\\p", JSON.stringify(reCreate));
  const promptBody = seen.unaryBodies.filter((b) => b.method === "session.prompt").at(-1);
  check("session.prompt 裸 payload {sessionId, mode, content}", promptBody?.payload?.mode === "queue" && Array.isArray(promptBody.payload.content), JSON.stringify(promptBody?.payload));

  await adapter.handleRequest({ requestId: "r7", type: "sessions.run", payload: { sessionId: "sess-1", content: [{ type: "text", text: "/plan x" }] } });
  const slash = seen.unaryBodies.find((b) => b.method === "commands/execute");
  check("斜杠命令 → commands/execute {args:{agentId,line,images}}", JSON.stringify(slash?.payload) === JSON.stringify({ args: { agentId: "sess-1", line: "/plan x", images: [] } }), JSON.stringify(slash?.payload));

  await adapter.handleRequest({ requestId: "r8", type: "sessions.create", payload: { cwd: "D:\\p" } });
  check("sessions.create ok", relayResponses.find((r) => r.requestId === "r8")?.payload?.ok === true);
  await adapter.handleRequest({ requestId: "r9", type: "sessions.updateQueue", payload: { sessionId: "sess-1", itemId: "q1", action: { kind: "edit", content: [{ type: "text", text: "x" }] } } });
  check("sessions.updateQueue ok", relayResponses.find((r) => r.requestId === "r9")?.payload?.ok === true);
  await adapter.handleRequest({ requestId: "r10", type: "session.models", payload: { sessionId: "sess-1" } });
  check("session.models → session.models（点号）", relayResponses.find((r) => r.requestId === "r10")?.payload?.ok === true);
  await adapter.handleRequest({ requestId: "r11", type: "commands.list", payload: { sessionId: "sess-1" } });
  check("commands.list → {args:{agentId}}", seen.unaryBodies.find((b) => b.method === "commands/list")?.payload?.args?.agentId === "sess-1");
  await adapter.handleRequest({ requestId: "r12", type: "workspace.list", payload: {} });
  check("workspace.list 直通", relayResponses.find((r) => r.requestId === "r12")?.payload?.data?.items?.[0]?.workspaceId === "ws-1");

  try { muxWs.close(); hostWs.close(); } catch {}
  console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILURES`);
} finally {
  for (const s of WS_CLIENTS) { try { s.destroy(); } catch {} }
  server.close();
  rmSync(stateDir, { recursive: true, force: true });
}
process.exit(failures === 0 ? 0 : 1);
