// relay 信封 ↔ DSH API 适配器。写权限模型：进入会话即可对话（与桌面 GUI 一致）。
import { createHash, randomUUID } from "node:crypto";
import { appendFileSync, createWriteStream } from "node:fs";
import { mkdir, opendir, open, readFile, rename, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { supportsRequireE2ee } from "./e2ee-policy.js";

/** E2EE 握手诊断日志（bridge stdio=ignore，故落盘；仅打点握手/降级关键事件，不含密钥）。 */
const E2EE_DEBUG_LOG = join(homedir(), ".dsh-mobile", "e2ee-debug.log");
function e2eeDebug(msg) {
  try {
    appendFileSync(E2EE_DEBUG_LOG, `${new Date().toISOString()} ${msg}\n`);
  } catch {
    /* 诊断日志失败不影响主流程 */
  }
}

const READ_ONLY_TYPES = new Set(["sessions.list", "sessions.history", "session.models", "commands.list", "events.subscribe", "events.unsubscribe", "workspace.list", "host.listDirectory", "host.listDrives"]);
const WRITE_TYPES = new Set(["sessions.create", "sessions.run", "sessions.interrupt", "sessions.steer", "session.selectModel", "commands.execute", "approvals.respond", "questions.respond", "sessions.rename", "sessions.fork", "sessions.archive", "sessions.updateQueue", "host.createDirectory", "sessions.markSeen"]);

/** 读取文件头部若干字节用于魔数嗅探（避免为非图片的大文件整体读入内存）。 */
async function readFileHeader(path, len = 16) {
  const fh = await open(path, "r");
  try {
    const buf = Buffer.alloc(len);
    const { bytesRead } = await fh.read(buf, 0, len, 0);
    return buf.subarray(0, bytesRead);
  } finally {
    await fh.close();
  }
}

/** 从字节魔数嗅探图片 mediaType（png/jpeg/webp/gif），非图片返回 null。 */
function sniffImageMediaType(buf) {
  if (!buf || buf.length < 4) return null;
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return "image/jpeg";
  if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) return "image/png";
  if (buf[0] === 0x47 && buf[1] === 0x49 && buf[2] === 0x46 && buf[3] === 0x38) return "image/gif";
  if (buf.length >= 12 && buf[0] === 0x52 && buf[1] === 0x49 && buf[2] === 0x46 && buf[3] === 0x46 && buf[8] === 0x57 && buf[9] === 0x45 && buf[10] === 0x42 && buf[11] === 0x50) return "image/webp";
  return null;
}

/** 祖先链（从文件系统根到 target，含盘符根）——手机端面包屑回退/换盘用。 */
function ancestryCrumbs(target) {
  const crumbs = [];
  let current = target;
  for (;;) {
    const parent = dirname(current);
    crumbs.unshift({ name: parent === current ? current : basename(current), path: current, hidden: false });
    if (parent === current) return crumbs;
    current = parent;
  }
}

const TOOL_TEXT_LIMIT = 500;

/** 在 {content:[...]} 容器里剥掉 reasoning；无 reasoning 时返回 null 表示无需改动。 */
function stripReasoningIn(container) {
  const content = container?.content;
  if (!Array.isArray(content) || content.length === 0) return null;
  const kept = content.filter((b) => b?.type !== "reasoning");
  return kept.length === content.length ? null : kept;
}

/** B1：剥离 assistant/message 的 reasoning 块。
 * 手机端从不渲染思考（实测占 content 字节 63%~70%），白传；桌面端不受影响（桥只做下行投影）。
 * v2 形状是 data.message.content；legacy 存在 data.content 变体，两种都处理。 */
function stripReasoning(event) {
  if (!event || event.type !== "assistant/message") return event;
  const message = event.data?.message;
  const keptInMessage = stripReasoningIn(message);
  if (keptInMessage) {
    return { ...event, data: { ...event.data, message: { ...message, content: keptInMessage } } };
  }
  const keptInData = stripReasoningIn(event.data);
  if (keptInData) return { ...event, data: { ...event.data, content: keptInData } };
  return event;
}

/**
 * B2：tool/result 压缩。真实结构（会话日志 + 实时 API 双向确认）：
 *   data.message.content = [{ type:'tool-result', toolCallId, content:[{ type:'text', text }] }]
 * 旧实现只判断顶层 type==='text'（与真实结构不符、却与 smoke 夹具的扁平形状一致）→ 从未生效，
 * 导致工具输出"全文传输 + 手机一个字也显示不出来"。
 * 这里按真实层级截断内层文本，并附加 data.toolSummary 摘要字段（新 App 渲染用，老 App 忽略）。
 * 被截断的全文交给 remember() 存入桥内 LRU，供 toolResult.full 按需取回。
 */
function compactToolResult(message, meta, remember) {
  const content = message?.content;
  if (!Array.isArray(content)) return { message, summary: null };
  let bytes = 0;
  let preview = "";
  let truncated = false;
  let callId = typeof meta?.callId === "string" ? meta.callId : null;
  const full = [];
  const next = content.map((block) => {
    if (block?.type !== "tool-result" || !Array.isArray(block.content)) return block;
    if (!callId && typeof block.toolCallId === "string") callId = block.toolCallId;
    const inner = block.content.map((b) => {
      if (b?.type !== "text" || typeof b.text !== "string") return b;
      bytes += Buffer.byteLength(b.text);
      full.push(b.text);
      if (!preview) preview = b.text.slice(0, TOOL_TEXT_LIMIT);
      if (b.text.length > TOOL_TEXT_LIMIT) {
        truncated = true;
        return { ...b, text: b.text.slice(0, TOOL_TEXT_LIMIT) + "\n…[截断]" };
      }
      return b;
    });
    return { ...block, content: inner };
  });
  if (bytes === 0) return { message, summary: null };
  if (truncated && typeof remember === "function") {
    remember({ callId, seq: meta?.seq, sessionId: meta?.sessionId, text: full.join("\n") });
  }
  return { message: { ...message, content: next }, summary: { callId, bytes, truncated, preview } };
}

/**
 * history wire 投影：剥离 UI 不渲染的海量流式碎片（assistant/chunk、step/*）、
 * 剥掉 reasoning、压缩工具输出。4.3MB 大会话压到 ~50KB，解决服务器 1Mbps 带宽下的传输瓶颈。
 */
function compactHistoryEvents(events, opts = {}) {
  const { sessionId, remember } = opts;
  const kept = [];
  for (const event of events) {
    const t = event?.type;
    if (t === "assistant/chunk" || t === "step/start" || t === "step/end") continue;
    if (t === "tool/result") {
      const { message, summary } = compactToolResult(
        event.data?.message,
        { sessionId, seq: event?.seq, callId: event.data?.message?.source?.callId },
        remember,
      );
      kept.push(summary ? { ...event, data: { ...event.data, message, toolSummary: summary } } : event);
      continue;
    }
    kept.push(stripReasoning(event));
  }
  return kept;
}


/**
 * 在 workspaceRoot 内解析相对路径：拒绝绝对路径、`..` 穿越、空字节，
 * 规范化后必须仍在 root 内（防符号链接/拼接逃逸）。
 */
export function resolveInRoot(root, rel) {
  const base = resolve(root);
  if (typeof rel !== "string" || !rel.trim() || rel.includes("\0")) {
    throw new Error("empty or invalid target path");
  }
  if (isAbsolute(rel)) throw new Error("absolute paths not allowed");
  const target = resolve(base, rel);
  const relResolved = relative(base, target);
  if (relResolved === ".." || relResolved.startsWith(".." + sep) || isAbsolute(relResolved)) {
    throw new Error("path escapes workspace root");
  }
  return target;
}

export class Adapter {
  constructor({ dsh, relay, workspaceRoot, e2ee = null }) {
    this.dsh = dsh;
    this.relay = relay;
    this.e2ee = e2ee;
    // Data plane 落盘根目录（默认由 main.js 注入 <stateDir>/deliveries）
    this.workspaceRoot = workspaceRoot || join(homedir(), "dsh-deliveries");
    // sessionId -> Set<订阅标记>（MVP: 仅记录，事件 fanout 给全部客户端由 relay 完成）
    this.subscribed = new Map();
    // 待应答请求暂存：question/requested、approval/requested 帧到达时如果没有客户端订阅，
    // 先存下来；客户端随后 events.subscribe 时重放（手机随时断连，不能丢提问/审批）。
    // sessionId -> [{rpcId, payload}]
    this.pendingRequests = new Map();
    // sessionId -> cwd（从 sessions.list 缓存，供 session-not-found 时按原 cwd 重建/恢复）
    this.sessionCwd = new Map();
    // sessionId -> SessionSummary（subagent 会话需按 origin/parentSessionId 构造地址）
    this.sessionMeta = new Map();
    // 归档集合缓存（workspace/follow 基线 + 增量更新）
    this.archivedSessionIds = [];
    // sessionId -> 最近一次 session/queue 帧（客户端订阅时重放，保证 QueueDock 状态不丢）
    this.queueFrames = new Map();
    // App 内提醒：sessionId -> 有「已完成但未查看」的对话（绿点）
    this.completedSessions = new Set();
    // 当前回合出过 assistant 消息的会话（用于区分 turn/end 是「完成」还是「等待审批/提问」）
    this.turnProducedResponse = new Set();
    // 上次推给手机的 host/session-flags 快照（内容相同则不重复推帧）
    this.lastSessionFlags = null;

    // ---- E2EE 默认强制 + 显式降级（全部只在内存，桥重启即回到"要求加密"）----
    this.clientAppVersions = new Map();       // clientId -> 最近上报的 appVersion（§5 版本闸门）
    this.plaintextSessionAllowed = new Set(); // clientId 本次进程内被临时放行明文（e2ee.allowPlaintext mode=session）
    this.lastE2eeState = null;                // 上次推过的 host/e2ee-state 快照（内容相同则不重复推帧）
    // pin/策略变化（配对成功、e2ee.allowPlaintext、e2ee.clear、策略被外部改写）→ 主动推 host/e2ee-state 帧
    if (this.e2ee) this.e2ee.onStateChange = () => this.#emitE2eeState();
    // 明文强制拒绝的判定权在本类（策略 + 版本闸门 + 临时放行）；自注册给 relay，
    // 避免 relay 反向 import adapter 造成循环依赖。未注册 → relay 一律放行（裸用/旧测试语义不变）。
    this.relay?.setPlaintextGuard?.((env) => this.isPlaintextAllowed(env));

    // ---- 新版 DSH（v0.1.5+）流层状态 ----
    this.mux = null;                 // /api/remote.mux 物理连接
    this.eventsClientId = "";        // $events 流 ready 帧下发的 clientId（$events/result 应答用）
    this.sessionFollows = new Map(); // sessionId -> { handle, cursor, projections, snapshot }
    this.workspaceBaseline = null;   // workspace/follow 基线 { items, archivedSessionIds }
    this.workspaceWaiter = null;     // 等待首个 workspace 基线的 promise
    // eventId（$events waterfall rpcId）-> { sessionId, frame, request }，供 cancel 应答与重放
    this.waterfallStash = new Map();
    // 工具输出全文缓存（toolResult.full 按需取回）：被截断的 tool/result 存这里，LRU 逐出
    this.toolFullCache = new Map();
    this.toolFullCacheBytes = 0;
  }


  /**
   * 挂载 /api/remote.mux：重开全部常驻流（$events、session/control、workspace/follow）
   * 与所有已订阅会话的 session/follow。物理连接重建后由 main.js 再次调用。
   */
  attachMux(mux) {
    this.mux = mux;
    this.eventsClientId = "";
    this.workspaceBaseline = null;
    this.workspaceWaiter = null;
    const log = (what) => (err) => console.warn(`[dsh] stream ${what}:`, err?.message ?? err);
    mux.openStream("$events", {}, {
      onItem: (v) => this.handleRemoteEvent(v),
      onError: log("$events error"),
    }).catch(log("$events open"));
    mux.openStream("session/control", {}, {
      onItem: (v) => this.handleControlFrame(v),
      onError: log("session/control error"),
    }).catch(log("session/control open"));
    mux.openStream("workspace/follow", {}, {
      onItem: (v) => this.handleWorkspaceFrame(v),
      onError: log("workspace/follow error"),
    }).catch(log("workspace/follow open"));
    for (const sessionId of [...this.sessionFollows.keys()]) {
      this.#openSessionFollow(sessionId).catch(log(`session/follow(${sessionId}) reopen`));
    }
  }

  /** workspace 基线就绪（首帧 snapshot）；超时返回 null，不阻塞请求。 */
  ensureWorkspaceBaseline() {
    if (this.workspaceBaseline) return Promise.resolve(this.workspaceBaseline);
    if (!this.workspaceWaiter) {
      this.workspaceWaiter = new Promise((resolve) => {
        const t = setTimeout(() => {
          if (!this.workspaceBaseline) {
            this.workspaceWaiter = null;
            resolve(null);
          }
        }, 15000);
        this.workspaceWaiterDone = (v) => {
          clearTimeout(t);
          this.workspaceWaiter = null;
          resolve(v);
        };
      });
    }
    return this.workspaceWaiter;
  }

  /** 确保某会话的 session/follow 流存在，并等待首个 snapshot（拿 cursor/projections）。 */
  async ensureSessionFollow(sessionId) {
    const existing = this.sessionFollows.get(sessionId);
    if (existing && existing.handle && existing.snapshot) return existing;
    const entry = existing ?? { handle: null, cursor: -1, projections: null, snapshot: null };
    if (!this.sessionFollows.has(sessionId)) this.sessionFollows.set(sessionId, entry);
    if (!entry.handle) await this.#openSessionFollow(sessionId);
    if (!entry.snapshot) {
      // 等 snapshot 首帧（最多 15s，超时按空会话处理）
      entry.snapshotPromise ??= new Promise((resolve) => {
        const t = setTimeout(() => resolve(null), 15000);
        entry.snapshotDone = (v) => { clearTimeout(t); resolve(v); };
      });
      await entry.snapshotPromise;
    }
    return entry;
  }

  /** 按 SessionSummary 构造 follow/page 地址：subagent 会话需带父会话与模式。 */
  #addressFor(sessionId) {
    const meta = this.sessionMeta.get(sessionId);
    if (meta?.origin === "subagent" && typeof meta.parentSessionId === "string") {
      const mode = meta.projections?.values?.subagent?.mode;
      if (mode === "one-shot" || mode === "continuable") {
        return { kind: "subagent", parentSessionId: meta.parentSessionId, childSessionId: sessionId, mode };
      }
    }
    return { kind: "session", sessionId };
  }

  async #openSessionFollow(sessionId) {
    const entry = this.sessionFollows.get(sessionId);
    if (!entry || !this.mux) return;
    if (entry.handle) { try { entry.handle.cancel(); } catch { /* 换新 */ } }
    const handle = await this.mux.openStream("session/follow", {
      request: { address: this.#addressFor(sessionId) },
    }, {
      onItem: (v) => this.handleSessionFollowFrame(sessionId, v),
      onError: (err) => {
        const cur = this.sessionFollows.get(sessionId);
        if (cur?.handle === handle) {
          console.warn(`[dsh] session/follow(${sessionId}) error:`, err?.message ?? err);
          cur.snapshotDone?.(null); // 唤醒等待 snapshot 的 history 调用（按空会话继续）
          this.sessionFollows.delete(sessionId);
        }
      },
      onEnd: () => {
        const cur = this.sessionFollows.get(sessionId);
        if (cur?.handle === handle) {
          cur.snapshotDone?.(null);
          this.sessionFollows.delete(sessionId);
        }
      },
    });
    entry.handle = handle;
  }

  /** session/follow 帧：snapshot 记游标/投影；event 帧按旧协议转发为 session/event。
   *  关键：每条 live event 都要推进 entry.cursor——历史请求以它作 throughSeq 分页，
   *  不推进会导致手机刷新历史时只能看到订阅时刻之前的旧对话。 */
  handleSessionFollowFrame(sessionId, value) {
    if (!value || typeof value.type !== "string") return;
    if (value.type === "snapshot") {
      const entry = this.sessionFollows.get(sessionId);
      if (entry) {
        entry.cursor = value.cursor ?? -1;
        entry.projections = value.projections ?? null;
        entry.snapshot = value;
        entry.snapshotDone?.(value);
      }
      return;
    }
    if (value.type === "event") {
      const entry = this.sessionFollows.get(sessionId);
      if (entry && Number.isInteger(value.event?.seq) && value.event.seq > (entry.cursor ?? -1)) {
        entry.cursor = value.event.seq;
      }
      this.#forwardSessionEvent(sessionId, value.event);
    }
    // assistant-stream 帧不转发（手机不渲染流式碎片）
  }

  /** 旧协议 session/event 帧转发：压缩碎片 + 绿点状态跟踪。 */
  #forwardSessionEvent(sid, event) {
    if (!event || typeof event.type !== "string") return;
    const et = event.type;
    if (typeof sid === "string") {
      if (et === "turn/start") this.turnProducedResponse.delete(sid);
      else if (et === "assistant/message") this.turnProducedResponse.add(sid);
      else if (et === "turn/end") {
        if (this.turnProducedResponse.has(sid)) {
          this.completedSessions.add(sid);
          this.turnProducedResponse.delete(sid);
          this.#emitSessionFlags(); // 绿点出现：实时推帧
        }
      }
    }
    if (et === "assistant/chunk" || et === "step/start" || et === "step/end") {
      this._chunkDropped = (this._chunkDropped ?? 0) + 1;
      if (this._chunkDropped % 500 === 1) console.log("[adapter] live chunks dropped (unrendered):", this._chunkDropped);
      return;
    }
    this.relay.forwardEvent({
      sessionId: typeof sid === "string" ? sid : undefined,
      frame: { type: "session/event", sessionId: sid, event: this.#projectLiveEvent(sid, event) },
    });
  }

  /** 实时事件下行投影：剥 reasoning + 压缩工具输出（与 history 投影同口径）。 */
  #projectLiveEvent(sid, event) {
    if (event.type === "tool/result") {
      const { message, summary } = compactToolResult(
        event.data?.message,
        { sessionId: sid, seq: event?.seq, callId: event.data?.message?.source?.callId },
        (info) => this.#rememberToolFull(info),
      );
      return summary ? { ...event, data: { ...event.data, message, toolSummary: summary } } : event;
    }
    return stripReasoning(event);
  }

  /** 记录被截断的工具输出全文（供 toolResult.full 按需取回）。键优先 callId，其次 sessionId+seq。 */
  #rememberToolFull({ callId, seq, sessionId, text }) {
    if (typeof text !== "string" || text.length === 0) return;
    const key = typeof callId === "string" && callId
      ? `c:${callId}`
      : Number.isInteger(seq) ? `s:${typeof sessionId === "string" ? sessionId : ""}:${seq}` : null;
    if (!key || this.toolFullCache.has(key)) return;
    const bytes = Buffer.byteLength(text);
    this.toolFullCache.set(key, { text, bytes, at: Date.now() });
    this.toolFullCacheBytes += bytes;
    // LRU：最多 80 条 / 6MB，超出逐出最旧
    while (this.toolFullCache.size > 80 || this.toolFullCacheBytes > 6 * 1024 * 1024) {
      const oldest = this.toolFullCache.keys().next().value;
      if (oldest === undefined) break;
      this.toolFullCacheBytes -= this.toolFullCache.get(oldest)?.bytes ?? 0;
      this.toolFullCache.delete(oldest);
    }
  }

  /** 工具输出全文按需取回：{sessionId, callId?, seq?} → 完整文本；未命中回 not-cached。 */
  #toolResultFull(payload, requestId) {
    const { sessionId, callId, seq } = payload ?? {};
    const keys = [];
    if (typeof callId === "string" && callId) keys.push(`c:${callId}`);
    if (Number.isInteger(seq)) keys.push(`s:${typeof sessionId === "string" ? sessionId : ""}:${seq}`);
    for (const k of keys) {
      const hit = this.toolFullCache.get(k);
      if (hit) {
        // LRU 触达：移到队尾
        this.toolFullCache.delete(k);
        this.toolFullCache.set(k, hit);
        return this.relay.respond(requestId, "toolResult.full", { ok: true, data: { text: hit.text, bytes: hit.bytes } });
      }
    }
    return this.relay.respond(requestId, "toolResult.full", {
      ok: false,
      error: { code: "not-cached", message: "tool output not cached (bridge restarted or evicted); view it on the desktop" },
    });
  }

  /** $events 流：ready 记 clientId；waterfall=审批/提问；emit=会话元数据广播；cancel=他端已应答。 */
  handleRemoteEvent(value) {
    if (!value || typeof value.type !== "string") return;
    if (value.type === "ready") {
      this.eventsClientId = value.clientId ?? "";
      console.log("[dsh] $events ready, clientId:", this.eventsClientId);
      return;
    }
    if (value.type === "waterfall") return this.#handleWaterfall(value);
    if (value.type === "emit") return this.#handleEmit(value);
    if (value.type === "cancel") return this.#handleEventCancel(value);
  }

  #handleWaterfall(f) {
    const sid = typeof f.agentId === "string" ? f.agentId : undefined;
    const stash = { sessionId: sid, request: f.request ?? {} };
    if (f.event === "approval/request") {
      const p = f.request ?? {};
      // 新版 ApprovalRequestEvent 无独立 id（id 只存在于 session 的 approval/asked 事件）：
      // 用瀑布 eventId 充当展示/关联 id，并兼容手机旧字段 approvalId。
      // 帧内必须带 sessionId：App 按 frame.sessionId 过滤事件，缺了卡片不会弹出。
      const frame = {
        type: "approval/requested",
        sessionId: sid,
        id: f.eventId,
        approvalId: f.eventId,
        toolName: p.toolName,
        ...(typeof p.callId === "string" ? { callId: p.callId } : {}),
        ...(typeof p.reason === "string" ? { reason: p.reason } : {}),
      };
      this.waterfallStash.set(f.eventId, stash);
      if (typeof sid === "string") this.#stashPending(sid, f.eventId, frame);
      this.relay.forwardEvent({ sessionId: sid, frame, rpcId: f.eventId });
    } else if (f.event === "user-questions/request") {
      const p = f.request ?? {};
      const frame = { type: "question/requested", sessionId: sid, questions: Array.isArray(p.questions) ? p.questions : [] };
      this.waterfallStash.set(f.eventId, stash);
      if (typeof sid === "string") this.#stashPending(sid, f.eventId, frame);
      this.relay.forwardEvent({ sessionId: sid, frame, rpcId: f.eventId });
    }
    // 其余 waterfall 事件（暂无）不处理
  }

  #handleEmit(f) {
    const [a, b] = Array.isArray(f.args) ? f.args : [];
    switch (f.event) {
      case "api-session/added": {
        if (a?.sessionId) {
          this.sessionMeta.set(a.sessionId, a);
          if (typeof a.cwd === "string") this.sessionCwd.set(a.sessionId, a.cwd);
        }
        this.relay.forwardEvent({ frame: { type: "host/session-added", ...(a ?? {}) } });
        return;
      }
      case "api-session/removed": {
        this.sessionFollows.delete(a);
        this.relay.forwardEvent({ frame: { type: "host/session-removed", sessionId: a } });
        return;
      }
      case "api-session/status":
        this.relay.forwardEvent({ frame: { type: "host/session-status", sessionId: a, running: b === true } });
        return;
      case "api-session/error":
        this.relay.forwardEvent({ frame: { type: "host/session-error", sessionId: a, message: String(b ?? "") } });
        return;
      case "api-session/activity":
        this.relay.forwardEvent({ frame: { type: "host/session-activity", sessionId: a, updatedAt: b } });
        return;
      default:
        return; // 其余 emit 事件不转发
    }
  }

  #handleEventCancel(f) {
    const eventId = f.eventId;
    if (typeof eventId !== "string") return;
    const stash = this.waterfallStash.get(eventId);
    this.waterfallStash.delete(eventId);
    if (!stash) return;
    const { sessionId, request } = stash;
    const isApproval = Boolean(request?.toolName);
    // 帧内带 sessionId（App 按 frame.sessionId 过滤，缺了卡片不消失）
    const frame = isApproval
      ? { type: "approval/resolved", sessionId, id: request?.id }
      : { type: "question/resolved", sessionId, rpcId: eventId };
    if (typeof sessionId === "string") this.clearPendingRequest(eventId, sessionId);
    this.relay.forwardEvent({ sessionId, frame, rpcId: eventId });
  }

  /** session/control 流：队列快照/增量 → session/queue 帧（重放缓存）。 */
  handleControlFrame(value) {
    if (!value || typeof value.type !== "string") return;
    if (value.type === "baseline") {
      for (const [sid, items] of Object.entries(value.value?.queues ?? {})) this.#forwardQueue(sid, items);
      return;
    }
    if (value.type === "queue" && typeof value.sessionId === "string") this.#forwardQueue(value.sessionId, value.items);
  }

  #forwardQueue(sid, items) {
    const frame = { type: "session/queue", sessionId: sid, items: Array.isArray(items) ? items : [] };
    this.queueFrames.set(sid, frame);
    this.relay.forwardEvent({ sessionId: sid, frame });
  }

  /** workspace/follow 流：基线/增量维护工作区列表与归档集合。 */
  handleWorkspaceFrame(value) {
    if (!value || typeof value.type !== "string") return;
    const base = this.workspaceBaseline ?? { items: [], archivedSessionIds: [] };
    if (value.type === "baseline") {
      this.workspaceBaseline = {
        items: Array.isArray(value.value?.items) ? value.value.items : [],
        archivedSessionIds: Array.isArray(value.value?.archivedSessionIds) ? value.value.archivedSessionIds : [],
      };
      this.archivedSessionIds = [...this.workspaceBaseline.archivedSessionIds];
      this.workspaceWaiterDone?.(this.workspaceBaseline);
      return;
    }
    if (value.type === "upsert" && value.workspace?.workspaceId) {
      const idx = base.items.findIndex((w) => w.workspaceId === value.workspace.workspaceId);
      if (idx >= 0) base.items[idx] = value.workspace; else base.items.push(value.workspace);
      this.workspaceBaseline = base;
      // 转推给手机：会话列表按工作区分组用（新增帧类型，不改既有响应字段）
      this.relay.forwardEvent({ frame: { type: "host/workspace-changed", workspace: value.workspace } });
    } else if (value.type === "remove") {
      base.items = base.items.filter((w) => w.workspaceId !== value.workspaceId);
      this.workspaceBaseline = base;
      this.relay.forwardEvent({ frame: { type: "host/workspace-changed", removedWorkspaceId: value.workspaceId } });
    } else if (value.type === "order" && Array.isArray(value.workspaceIds)) {
      base.items.sort((a, b) => {
        const ai = value.workspaceIds.indexOf(a.workspaceId);
        const bi = value.workspaceIds.indexOf(b.workspaceId);
        return (ai < 0 ? 1e9 : ai) - (bi < 0 ? 1e9 : bi);
      });
      this.workspaceBaseline = base;
      this.relay.forwardEvent({ frame: { type: "host/workspace-order", workspaceIds: value.workspaceIds } });
    } else if (value.type === "archived" && Array.isArray(value.archivedSessionIds)) {
      base.archivedSessionIds = value.archivedSessionIds;
      this.workspaceBaseline = base;
      this.archivedSessionIds = [...value.archivedSessionIds];
      this.relay.forwardEvent({ frame: { type: "host/archived-sessions-changed", archivedSessionIds: value.archivedSessionIds } });
    }
  }

  /** 暂存无人订阅时的提问/审批帧（客户端 events.subscribe 时重放）。 */
  #stashPending(sessionId, rpcId, frame) {
    const entry = { rpcId, payload: frame };
    const stash = this.pendingRequests.get(sessionId) ?? [];
    const idx = stash.findIndex((e) => e.rpcId === rpcId && e.payload.type === frame.type);
    if (idx >= 0) stash[idx] = entry; else stash.push(entry);
    this.pendingRequests.set(sessionId, stash);
    this.#emitSessionFlags();
  }

  /**
   * 绿点（completedSessions）/ 黄点（pendingRequests）状态变化 → 主动推一帧 host/session-flags，
   * App 不必等下一次 sessions.list 刷新即可实时更新点状态。
   * 与上次推送过的快照完全相同则不推（避免重复帧）；只增帧、不改动集合与既有响应字段。
   */
  #emitSessionFlags() {
    const completedSessionIds = [...this.completedSessions];
    const pendingSessionIds = [...this.pendingRequests.keys()];
    const snapshot = JSON.stringify({
      completedSessionIds: [...completedSessionIds].sort(),
      pendingSessionIds: [...pendingSessionIds].sort(),
    });
    if (snapshot === this.lastSessionFlags) return;
    this.lastSessionFlags = snapshot;
    this.relay.forwardEvent({
      frame: { type: "host/session-flags", completedSessionIds, pendingSessionIds },
    });
  }

  // ---- E2EE 明文策略（默认强制 + 用户显式降级）----

  /** 本机 E2EE 状态快照：响应（e2ee.state / sessions.list）与帧（host/e2ee-state）共用同一口径。 */
  #e2eeState() {
    const pin = this.e2ee?.pinState ?? {};
    return {
      require: this.e2ee?.require === true,
      pinned: pin.pinned === true,
      bridgeKeyId: typeof pin.bridgeKeyId === "string" ? pin.bridgeKeyId : "",
    };
  }

  /** pin/策略变化 → 推一帧 host/e2ee-state（与上次推过的快照相同则不推）。只加帧，不改任何既有帧。 */
  #emitE2eeState() {
    const state = this.#e2eeState();
    const snapshot = JSON.stringify(state);
    if (snapshot === this.lastE2eeState) return;
    this.lastE2eeState = snapshot;
    this.relay?.forwardEvent?.({ frame: { type: "host/e2ee-state", ...state } });
  }

  /**
   * §2 明文强制拒绝的判定入口（relay.decryptEnvelope 在「未建立 E2EE + 收到明文业务请求」时回调）。
   * 返回 false = 拒绝（relay 回 E2EE_REQUIRED）；true = 放行。三个条件必须**同时**满足才拒绝，
   * 任一不满足都 fail-open（宁可放明文也不把用户卡死）：
   *   ① 本机策略要求加密（e2ee-policy.json 的 require，默认 true）；
   *   ② 该客户端被确认支持新协议：上报过 appVersion 且 ≥ 0.2.21（**未知版本的老 App 一律放行**）；
   *   ③ 该 clientId 本次进程内没有被临时放行（e2ee.allowPlaintext mode=session）。
   * 控制类类型（心跳/握手/配对/e2ee.clear/e2ee.state/e2ee.allowPlaintext/transfer.deliver）
   * 在 relay 的 PLAINTEXT_TYPES 里已提前放行，根本不会走到这里。
   */
  isPlaintextAllowed(env) {
    if (!this.e2ee) return true; // 没启用 E2EE：无从要求
    // 明文判定发生在 handleRequest 之前，版本只能从当前信封读（只记在 handleRequest 会让客户端**第一条**
    // 带 appVersion 的明文请求因"版本未知"被放行）。handleRequest 入口同样会记一次（§5 契约）。
    this.#noteAppVersion(env);
    if (this.e2ee.require !== true) return true; // 用户已明确选择永久非加密（或本机不要求）
    const clientId = typeof env?.actor?.clientId === "string" ? env.actor.clientId : "";
    if (this.plaintextSessionAllowed.has(clientId)) return true;
    const version = this.clientAppVersions.get(clientId);
    if (!supportsRequireE2ee(version)) return true; // 未上报/过低/解析不出 → 老 App，放行
    return false; // 三条件全满足：拒绝明文，让 App 提示"重新配对 或 明确选择降级"
  }

  /**
   * 记住客户端上报的 appVersion（§5 版本闸门的数据来源；仅内存，桥重启即清空）。
   * 首次看到某 clientId 的版本（或版本变化）时顺手推一帧 host/e2ee-state，让 App 立刻知道本机状态。
   */
  #noteAppVersion(env) {
    const clientId = typeof env?.actor?.clientId === "string" ? env.actor.clientId : "";
    const version = env?.appVersion;
    if (!clientId || typeof version !== "string" || version === "") return;
    const prev = this.clientAppVersions.get(clientId);
    this.clientAppVersions.set(clientId, version);
    if (prev === version) return;
    this.#emitE2eeState();
  }

  /**
   * e2ee.state（明文控制面）：手机一上线就问「这台 PC 是否要求加密 / 是否已配对」。
   * 会话列表可能已被 E2EE_REQUIRED 拒掉，所以这个入口必须永远可用。
   */
  #e2eeStateRequest(payload, requestId) {
    return this.relay.respond(requestId, "e2ee.state", { ok: true, data: this.#e2eeState() });
  }

  /**
   * e2ee.allowPlaintext（明文控制面）：用户**明确选择**降级到明文。
   *  - mode="session"：只在桥内存里对该 clientId 放行明文业务请求（桥重启即失效），不清 pin、不改策略；
   *  - mode="permanent"：清 pin + setRequire(false)（落盘）——与老的 e2ee.clear 等价。
   * 人在外地（碰不到电脑面板）也能靠它自救；没有这一步，"默认强制"会变成"永久卡死"。
   */
  #e2eeAllowPlaintext(payload, requestId, env) {
    const mode = payload?.mode;
    if (mode !== "session" && mode !== "permanent") {
      return this.relay.respond(requestId, "e2ee.allowPlaintext", {
        ok: false,
        error: { code: "bad-request", message: "mode must be session | permanent" },
      });
    }
    if (!this.e2ee) {
      return this.relay.respond(requestId, "e2ee.allowPlaintext", {
        ok: false,
        error: { code: "disabled", message: "e2ee not available" },
      });
    }
    if (mode === "session") {
      const clientId = typeof env?.actor?.clientId === "string" ? env.actor.clientId : "";
      this.plaintextSessionAllowed.add(clientId);
      e2eeDebug(`e2ee.allowPlaintext session -> clientId=${clientId || "(none)"} 临时放行明文（不持久化）`);
      this.#emitE2eeState(); // 状态未变时会被去重掉（不改策略/不清 pin）
      return this.relay.respond(requestId, "e2ee.allowPlaintext", { ok: true, data: { mode, ...this.#e2eeState() } });
    }
    this.e2ee.clearPin();
    this.e2ee.setRequire(false);
    e2eeDebug("e2ee.allowPlaintext permanent -> pin cleared + policy require=false (persisted)");
    this.#emitE2eeState();
    return this.relay.respond(requestId, "e2ee.allowPlaintext", { ok: true, data: { mode, ...this.#e2eeState() } });
  }

  /** relay 请求入口。envelope: canonical request。 */
  async handleRequest(env) {
    const { requestId, type, payload = {} } = env;
    if (typeof requestId !== "string") return;
    console.log("[adapter] request:", type, "from", env.actor?.clientId ?? "?", "payload:", JSON.stringify(payload).slice(0, 400));
    // §5 版本闸门的数据来源：记住该 clientId 上报的 appVersion（决定它是否会被"明文强制拒绝"）。
    this.#noteAppVersion(env);

    if (type === "transfer.deliver") {
      // 投递指令只接受 relay 发起（relay→桥 控制面）；手机从不发此类型，拒绝伪装明文。
      if (env.actor?.role !== "relay") {
        return this.relay.respond(requestId, type, { ok: false, error: { code: "forbidden", message: "transfer.deliver is relay-only" } });
      }
      return this.#deliver(payload, requestId);
    }
    if (type === "upload.commit") return this.#commitUpload(payload, requestId);
    if (type === "toolResult.full") return this.#toolResultFull(payload, requestId);
    if (type === "attachment.resolve") return this.#resolveAttachment(payload, requestId);
    if (type === "key.exchange") return this.#keyExchange(payload, requestId, env);
    if (type === "e2ee.hello") return this.#e2eeHello(payload, requestId);
    if (type === "e2ee.clear") return this.#e2eeClear(payload, requestId);
    if (type === "e2ee.state") return this.#e2eeStateRequest(payload, requestId);
    if (type === "e2ee.allowPlaintext") return this.#e2eeAllowPlaintext(payload, requestId, env);

    if (READ_ONLY_TYPES.has(type)) return this.#read(type, payload, requestId);
    if (WRITE_TYPES.has(type)) return this.#write(type, payload, requestId);

    this.relay.respond(requestId, type, {
      ok: false,
      error: { code: "UNSUPPORTED", message: `message type '${type}' is not implemented by this bridge` },
    });
  }

  /** 取消 E2EE 配对：清 pin + setRequire(false)（等价于老的"永久非加密"入口，语义与 allowPlaintext permanent 一致）。 */
  #e2eeClear(payload, requestId) {
    if (!this.e2ee) return this.relay.respond(requestId, "e2ee.clear", { ok: false, error: { code: "disabled", message: "e2ee not available" } });
    this.e2ee.clearPin();
    this.e2ee.setRequire(false); // 用户明确取消加密 = 永久非加密（否则一重启又变成"要求加密"）
    e2eeDebug("e2ee.clear -> pin cleared + policy require=false, back to legacy plaintext");
    this.#emitE2eeState();
    return this.relay.respond(requestId, "e2ee.clear", { ok: true, data: { cleared: true } });
  }

  /** E2EE 配对握手：按 pairingId 查 secret，校验 phone auth，pin 其身份公钥。 */
  #keyExchange(payload, requestId, env) {
    const { pairingId, deviceId, pub, auth } = payload ?? {};
    const fail = (code, message) =>
      this.relay.respond(requestId, "key.exchange", { ok: false, error: { code, message } });
    if (!this.e2ee) return fail("disabled", "e2ee not available");
    if (typeof pairingId !== "string" || typeof deviceId !== "string" || typeof pub !== "string" || typeof auth !== "string") {
      return fail("bad-request", "pairingId/deviceId/pub/auth required");
    }
    const r = this.e2ee.completePairing({ pairingId, deviceId, phonePubB64url: pub, authB64url: auth });
    e2eeDebug(`key.exchange pairingId=${pairingId} deviceId=${deviceId} result=${r.ok ? "ok(pinned keyId=" + r.data?.peerKeyId + ")" : "fail(" + r.error?.code + ")"}`);
    if (!r.ok) return this.relay.respond(requestId, "key.exchange", { ok: false, error: r.error });
    // 配对成功 = 端到端加密回来了：撤销该 clientId 本次进程内的「临时明文放行」。
    // 否则刚配完对的客户端仍能继续静默走明文——正是本轮要消除的行为（用户不知道自己在明文）。
    const clientId = typeof env?.actor?.clientId === "string" ? env.actor.clientId : "";
    if (this.plaintextSessionAllowed.delete(clientId)) {
      e2eeDebug(`key.exchange -> 撤销 clientId=${clientId} 的临时明文放行（配对成功）`);
    }
    // 配对成功 = 重新要求 E2EE（completePairing 内部已 setRequire(true) 并经状态钩子推帧；
    // 这里再显式推一次兜底，快照相同会被去重）。
    this.#emitE2eeState();
    return this.relay.respond(requestId, "key.exchange", { ok: true, data: r.data });
  }

  /** E2EE 每连接 hello：派生本连接密钥，回本端 keyId+cNonce。 */
  #e2eeHello(payload, requestId) {
    const fail = (code, message, data) =>
      this.relay.respond(requestId, "e2ee.hello", { ok: false, error: { code, message, ...(data ? { data } : {}) } });
    if (!this.e2ee) return fail("disabled", "e2ee not available");
    if (typeof payload?.keyId !== "string" || typeof payload?.cNonce !== "string") {
      return fail("bad-request", "keyId/cNonce required");
    }
    const hello = this.e2ee.beginConnection();
    if (!this.e2ee.establishConnection({ peerKeyIdHex: payload.keyId, peerCNonceB64url: payload.cNonce })) {
      const pin = this.e2ee.pinState ?? { pinned: this.e2ee.isPinned ?? false, bridgeKeyId: "", peerKeyId: null };
      // 错误码保持 "key-mismatch" 不变（老版 App 只认这个码，换码会让它们静默卡住、连提示都没有）；
      // 但把"为什么"放进 data：pinned=false 表示本机 E2EE 绑定已丢（重装/状态目录变化/身份文件损坏），
      // 新版 App 据此**自动丢弃过期 pin 并回退明文**，不再需要用户手动「取消加密」。
      const reason = pin.pinned ? "peer-key-changed" : "no-pin";
      const message = pin.pinned
        ? "peer keyId does not match pinned key"
        : "bridge has no E2EE pin (identity/pin lost); clear local pin and continue in plaintext, or re-pair with the ② QR";
      e2eeDebug(`e2ee.hello keyId=${payload.keyId} -> FAIL(key-mismatch reason=${reason} pinned=${pin.pinned} peer=${pin.peerKeyId} bridge=${pin.bridgeKeyId})`);
      return fail("key-mismatch", message, { reason, pinned: pin.pinned, bridgeKeyId: pin.bridgeKeyId, peerKeyId: pin.peerKeyId });
    }
    e2eeDebug(`e2ee.hello keyId=${payload.keyId} -> OK (connection keys derived)`);
    return this.relay.respond(requestId, "e2ee.hello", { ok: true, data: hello });
  }

  /**
   * Data plane 投递：从 relay 拉流下载 → 流式 SHA-256 校验 → workspace 内落盘。
   * 进度经控制面事件转发（节流 1s）。
   */
  async #deliver(payload, requestId) {
    const { transferId, fileId, name, size, sha256, targetPath } = payload ?? {};
    const fail = (code, message) =>
      this.relay.respond(requestId, "transfer.deliver", { ok: false, error: { code, message } });
    if (typeof transferId !== "string" || typeof name !== "string") {
      return fail("bad-request", "transferId/name required");
    }
    let target;
    try {
      target = resolveInRoot(this.workspaceRoot, targetPath || name);
    } catch (err) {
      return fail("bad-path", String(err?.message ?? err));
    }
    const tmp = `${target}.part-${randomUUID()}`;
    let lastProgress = 0;
    try {
      const res = await fetch(
        `${this.relay.url}/transfers/${encodeURIComponent(transferId)}/download`,
        { headers: { authorization: `Bearer ${this.relay.deviceToken}` } },
      );
      if (!res.ok || !res.body) {
        const body = await res.json().catch(() => ({}));
        throw new Error(`download failed: HTTP ${res.status} ${body?.error?.message ?? ""}`);
      }
      await mkdir(dirname(target), { recursive: true });
      const hash = createHash("sha256");
      const out = createWriteStream(tmp);
      let received = 0;
      for await (const chunk of res.body) {
        const buf = Buffer.from(chunk);
        hash.update(buf);
        received += buf.length;
        out.write(buf);
        const now = Date.now();
        if (now - lastProgress >= 1000) {
          lastProgress = now;
          this.relay.forwardEvent({ transferId, fileId, received, total: size }, "transfer.progress");
        }
      }
      await new Promise((r, j) => { out.end(r); out.on("error", j); });
      if (Number.isInteger(size) && received !== size) {
        throw new Error(`size mismatch: got ${received}, want ${size}`);
      }
      const digest = hash.digest("hex");
      if (sha256 && digest !== sha256) {
        throw new Error(`sha256 mismatch: got ${digest}, want ${sha256}`);
      }
      await rename(tmp, target);
      this.relay.forwardEvent({ transferId, fileId, received, total: size }, "transfer.progress");
      console.log("[adapter] deliver ok:", target);
      return this.relay.respond(requestId, "transfer.deliver", { ok: true, data: { path: target } });
    } catch (err) {
      try { await rename(tmp, `${tmp}.failed`); } catch {}
      console.error("[adapter] deliver failed:", err?.message);
      return fail("deliver-failed", String(err?.message ?? err));
    }
  }

  /**
   * Data plane 上传进会话：复核 relay 已投递落盘的文件，然后按 L1 发会话提及。
   * L2（视觉模型 image 块注入）依赖 DSH 附件公共 API 侦查结果，见 TODO 锚点。
   */
  /** 单次 session/prompt（queue 模式），带会话释放后的原位重建重试。 */
  async #promptOnce(sessionId, content) {
    const req = () => ({
      request: { requestId: randomUUID(), sessionId, mode: "queue", content },
    });
    let r = await this.dsh.unary("session/prompt", req(), { timeoutMs: 30000 });
    if (!r.ok && r.error?.code === "session/not-found") {
      // 与 sessions.run 同款重保障：DSH 释放会话后按原 cwd 原位重建再重试一次
      const cwd = this.sessionCwd.get(sessionId);
      const re = await this.dsh.unary(
        "session/create",
        { request: { sessionId, ...(cwd ? { cwd } : {}) } },
        { timeoutMs: 30000 },
      );
      if (re.ok) {
        r = await this.dsh.unary("session/prompt", req(), { timeoutMs: 30000 });
      }
    }
    return r;
  }

  async #commitUpload(payload, requestId) {
    const { transferId, name, size, targetPath, sessionId, text } = payload ?? {};
    const fail = (code, message) =>
      this.relay.respond(requestId, "upload.commit", { ok: false, error: { code, message } });
    if (typeof transferId !== "string" || typeof name !== "string") {
      return fail("bad-request", "transferId/name required");
    }
    let target;
    try {
      target = resolveInRoot(this.workspaceRoot, targetPath || name);
    } catch (err) {
      return fail("bad-path", String(err?.message ?? err));
    }
    // 复核落盘：文件必须已在 workspace 边界内，且大小一致
    let st;
    try {
      st = await stat(target);
    } catch {
      return fail("not-landed", `file not landed yet: ${target}`);
    }
    if (Number.isInteger(size) && st.size !== size) {
      return fail("size-mismatch", `size mismatch: disk ${st.size}, want ${size}`);
    }
    // 单条消息：文字与附件合并为一次 session.prompt，杜绝「两条 prompt 先后到」。
    // 图片 → 原生 image 块注入（DSH apiproxy 自动 admit 落库，text-only 模型由 DSH 降级为省略提示）；
    // 非图片 → 路径提及，任何模型可用工具读文件。
    let noticeFailed = null;
    let injectedAsImage = false;
    if (typeof sessionId === "string" && sessionId) {
      try {
        const note = `[附件已上传: ${name} → ${target}]`;
        const textBlock = {
          type: "text",
          text: typeof text === "string" && text.trim() ? `${text.trim()}\n\n${note}` : note,
        };
        let mediaType = null;
        let imageData = null;
        try {
          mediaType = sniffImageMediaType(await readFileHeader(target));
          if (mediaType) imageData = (await readFile(target)).toString("base64");
        } catch {
          mediaType = null;
        }
        if (mediaType && imageData) {
          const imageBlock = { type: "image", mediaType, data: imageData, name };
          let r = await this.#promptOnce(sessionId, [imageBlock, textBlock]);
          if (!r.ok) {
            // 图片注入失败（字节/类型不符、超限等）→ 降级为纯文本提及，并把原因带回给手机
            const imageErr = String(r.error?.message ?? JSON.stringify(r.error ?? r));
            r = await this.#promptOnce(sessionId, [textBlock]);
            if (!r.ok) noticeFailed = String(r.error?.message ?? "session.prompt failed");
            else noticeFailed = `图片注入失败（${imageErr}），已降级为文字提及`;
          } else {
            injectedAsImage = true;
          }
        } else {
          const r = await this.#promptOnce(sessionId, [textBlock]);
          if (!r.ok) noticeFailed = String(r.error?.message ?? "session.prompt failed");
        }
      } catch (err) {
        noticeFailed = String(err?.message ?? err);
      }
    }
    return this.relay.respond(requestId, "upload.commit", {
      ok: true,
      data: { path: target, noticeFailed, injectedAsImage },
    });
  }

  /** 以用户身份调用 relay REST（反向传输专用）。 */
  async #restAsUser(token, method, path, body) {
    const res = await fetch(`${this.relay.url}${path}`, {
      method,
      headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    const j = await res.json().catch(() => ({}));
    if (!res.ok || j.ok !== true) {
      throw new Error(`${path} failed: HTTP ${res.status} ${JSON.stringify(j.error ?? j)}`);
    }
    return j;
  }

  /** 以用户身份分块上传（反向传输）。 */
  async #chunkAsUser(token, transferId, offset, buf) {
    const res = await fetch(
      `${this.relay.url}/transfers/${encodeURIComponent(transferId)}/chunks`,
      {
        method: "PUT",
        headers: {
          "content-type": "application/octet-stream",
          "x-chunk-offset": String(offset),
          authorization: `Bearer ${token}`,
        },
        body: new Uint8Array(buf),
      },
    );
    const j = await res.json().catch(() => ({}));
    if (!res.ok || j.ok !== true) {
      throw new Error(`chunk failed: HTTP ${res.status} ${JSON.stringify(j.error ?? j)}`);
    }
    return Number(j.data?.received ?? 0);
  }

  /**
   * 反向传输：以用户身份把字节送入 relay spool（direction=download，ready 即终态）。
   * 幂等：同 fileId 复用已 ready 的 spool。返回 transferId。
   */
  async #reverseTransferAsUser(bytes, name, targetPath) {
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    const token = await this.relay.userAccessToken();
    const ann = await this.#restAsUser(token, "POST", "/transfers", {
      deviceId: this.relay.deviceId,
      fileId: sha256,
      name,
      size: bytes.length,
      sha256,
      targetPath,
      direction: "download",
    });
    const transferId = ann.data.transferId;
    if (ann.data.status !== "ready" && ann.data.received < bytes.length) {
      let offset = Number(ann.data.received ?? 0);
      const chunkSize = 4 * 1024 * 1024;
      while (offset < bytes.length) {
        const end = Math.min(offset + chunkSize, bytes.length);
        offset = await this.#chunkAsUser(token, transferId, offset, bytes.subarray(offset, end));
      }
      await this.#restAsUser(token, "POST", `/transfers/${transferId}/complete`, {});
    }
    return transferId;
  }

  /**
   * Data plane 附件回显（Phase B）：手机请求桥代取 DSH 附件字节 →
   * 反向传输进 relay spool → 回 transferId。
   */
  async #resolveAttachment(payload, requestId) {
    const { sessionId, attachmentId } = payload ?? {};
    const fail = (code, message) =>
      this.relay.respond(requestId, "attachment.resolve", { ok: false, error: { code, message } });
    if (typeof sessionId !== "string" || typeof attachmentId !== "string") {
      return fail("bad-request", "sessionId/attachmentId required");
    }
    try {
      const r = await this.dsh.unary("session/attachment", { request: { sessionId, attachmentId } }, { timeoutMs: 30000 });
      if (!r.ok || !r.value?.attachment || typeof r.value?.data !== "string") {
        return fail("attachment-unavailable", String(r.error?.message ?? "attachment not found"));
      }
      const { attachment, data } = r.value;
      const bytes = Buffer.from(data, "base64");
      const EXT = { "image/png": "png", "image/jpeg": "jpg", "image/webp": "webp", "image/gif": "gif" };
      const name = attachment.name || `${attachmentId}.${EXT[attachment.mediaType] ?? "bin"}`;
      const transferId = await this.#reverseTransferAsUser(bytes, name, `attachments/${attachmentId}`);
      return this.relay.respond(requestId, "attachment.resolve", {
        ok: true,
        data: { transferId, width: attachment.width, height: attachment.height, mediaType: attachment.mediaType, bytes: bytes.length },
      });
    } catch (err) {
      console.error("[adapter] attachment.resolve failed:", err?.message);
      return fail("resolve-failed", String(err?.message ?? err));
    }
  }

  async #read(type, payload, requestId) {
    switch (type) {
      case "sessions.list": {
        // 归档集合来自 workspace/follow 基线（新版无 workspace/list unary）
        const ws = await this.ensureWorkspaceBaseline();
        if (ws?.archivedSessionIds) this.archivedSessionIds = ws.archivedSessionIds;
        const r = await this.dsh.unary("session/list", { _request: {} }, { timeoutMs: 30000 });
        if (!r.ok) return this.relay.respond(requestId, type, { ok: false, error: r.error });
        // 标题在 projections.values.title；提到顶层兼容手机端旧渲染
        const items = (r.value.items ?? []).map((s) => ({
          ...s,
          ...(typeof s.projections?.values?.title === "string" ? { title: s.projections.values.title } : {}),
        }));
        // 缓存 cwd/summary：session 被 DSH 释放后可用 session/create {sessionId, cwd} 原位恢复；
        // summary 供 subagent 会话构造 follow/page 地址
        for (const s of items) {
          if (typeof s.sessionId === "string") {
            this.sessionMeta.set(s.sessionId, s);
            if (typeof s.cwd === "string") this.sessionCwd.set(s.sessionId, s.cwd);
          }
        }
        // 修剪已不在列表中的会话 follow（会话被释放/移除后不再订阅其事件）
        const live = new Set(items.map((s) => s.sessionId).filter(Boolean));
        for (const [sid, entry] of this.sessionFollows) {
          if (!live.has(sid)) {
            try { entry.handle?.cancel(); } catch { /* 忽略 */ }
            this.sessionFollows.delete(sid);
          }
        }
        return this.relay.respond(requestId, type, {
          ok: true,
          data: {
            sessions: items,
            archivedSessionIds: [...this.archivedSessionIds],
            // App 内提醒：绿点（完成未查看）/ 黄点（等待审批或提问）
            completedSessionIds: [...this.completedSessions],
            pendingSessionIds: [...this.pendingRequests.keys()],
            // 这份列表数据的生成时间（毫秒时间戳），供 App 显示「何时拉的」
            servedAt: Date.now(),
            // E2EE 状态（只增字段）：本机是否要求加密 / 是否已配对 / 本端身份 keyId
            e2ee: this.#e2eeState(),
          },
        });
      }
      case "sessions.history": {
        const { sessionId, beforeSeq, maxMessages } = payload;
        if (typeof sessionId !== "string") return this.relay.respond(requestId, type, { ok: false, error: { code: "bad-request", message: "sessionId is required" } });
        // 默认只取最近 20 条消息；上限 100 防止大会话打爆中继
        const capped = Math.min(Math.max(1, Number.isInteger(maxMessages) ? maxMessages : 10), 100);
        // session/page 需要真实 throughSeq（-1 恒为空页）：先用 follow 拿 cursor
        let cursor = -1;
        let projections = null;
        try {
          const entry = await this.ensureSessionFollow(sessionId);
          cursor = Number.isInteger(entry.cursor) ? entry.cursor : -1;
          projections = entry.projections ?? null;
        } catch (err) {
          console.warn("[adapter] session/follow for history failed:", err?.message ?? err);
        }
        const t0 = Date.now();
        const r = await this.dsh.unary("session/page", {
          request: {
            address: this.#addressFor(sessionId),
            throughSeq: cursor,
            ...(Number.isInteger(beforeSeq) ? { beforeSeq } : {}),
            maxMessages: capped,
          },
        }, { timeoutMs: 60000 });
        console.log("[adapter] history unary done in", Date.now() - t0, "ms, ok=", r.ok, "records=", r.value?.records?.length);
        if (!r.ok) return this.relay.respond(requestId, type, { ok: false, error: r.error });
        // 新版 records = [{type:"event", event: SessionWireEvent}]，投影到旧 events 数组
        const events = (r.value.records ?? [])
          .filter((rec) => rec?.type === "event" && rec.event)
          .map((rec) => rec.event);
        const compacted = compactHistoryEvents(events, {
          sessionId,
          remember: (info) => this.#rememberToolFull(info),
        });
        // DSH 条目的 seq 在 event 信封内；补到顶层作为客户端分页游标（beforeSeq）
        const wire = compacted.map((event) => ({ event, seq: event?.seq }));
        const dropped = events.length - wire.length;
        // projections 块（sessionStats/tokenUsage/contextPressure 等）原样透传，供客户端渲染统计条
        const data = { events: wire, hasMore: r.value.hasMore === true };
        if (projections) data.projections = projections;
        const size = JSON.stringify(data).length;
        console.log("[adapter] history compacted:", wire.length, "events (dropped", dropped, "chunks),", size, "bytes");
        const ts = Date.now();
        this.relay.respond(requestId, type, { ok: true, data });
        console.log("[adapter] history response sent in", Date.now() - ts, "ms");
        return;
      }
      case "events.subscribe": {
        const { sessionId } = payload;
        if (typeof sessionId !== "string") return this.relay.respond(requestId, type, { ok: false, error: { code: "bad-request", message: "sessionId is required" } });
        if (!this.subscribed.has(sessionId)) this.subscribed.set(sessionId, new Set());
        // 订阅即打开该会话的 session/follow 流（snapshot 记游标，后续事件转发手机）
        this.ensureSessionFollow(sessionId).catch((err) => {
          console.warn("[adapter] session/follow on subscribe failed:", err?.message ?? err);
        });
        this.relay.respond(requestId, type, { ok: true, data: { subscriptionId: sessionId } });
        // 重放未应答的提问/审批（帧到达时无人订阅 → 暂存；现在有人订阅了 → 补发）
        const stash = this.pendingRequests.get(sessionId);
        if (stash?.length) {
          console.log("[adapter] replaying", stash.length, "pending request(s) to session", sessionId);
          for (const { rpcId, payload: p } of stash) {
            this.relay.forwardEvent({ sessionId, frame: p, rpcId });
          }
        }
        // 重放最近一次收件箱快照（排队信息条状态）
        const q = this.queueFrames.get(sessionId);
        if (q) {
          this.relay.forwardEvent({ sessionId, frame: q });
        }
        return;
      }
      case "events.unsubscribe": {
        const { sessionId } = payload;
        if (typeof sessionId === "string") this.subscribed.delete(sessionId);
        return this.relay.respond(requestId, type, { ok: true, data: {} });
      }
      case "session.models": {
        const { sessionId } = payload;
        if (typeof sessionId !== "string") return this.relay.respond(requestId, type, { ok: false, error: { code: "bad-request", message: "sessionId is required" } });
        const r = await this.dsh.unary("session/modelCatalog", {}, { timeoutMs: 30000 });
        if (!r.ok) return this.relay.respond(requestId, type, { ok: false, error: r.error });
        // v2 ModelCatalog {default, routableProviders, groups, failures} → App 期望的 {current, routable, groups, failures}
        const c = r.value ?? {};
        return this.relay.respond(requestId, type, {
          ok: true,
          data: {
            current: c.default,
            routable: Array.isArray(c.routableProviders) && c.routableProviders.includes(c.default?.provider),
            groups: Array.isArray(c.groups) ? c.groups : [],
            failures: Array.isArray(c.failures) ? c.failures : [],
          },
        });
      }
      case "commands.list": {
        const { sessionId } = payload;
        if (typeof sessionId !== "string") return this.relay.respond(requestId, type, { ok: false, error: { code: "bad-request", message: "sessionId is required" } });
        const r = await this.dsh.unary("commands/list", { agentId: sessionId }, { timeoutMs: 30000 });
        if (!r.ok) return this.relay.respond(requestId, type, { ok: false, error: r.error });
        return this.relay.respond(requestId, type, { ok: true, data: { commands: r.value } });
      }
      case "workspace.list": {
        // 工作区列表：新建会话时选目录用（手机端目录选择，无需推送目录）
        const ws = await this.ensureWorkspaceBaseline();
        if (!ws) return this.relay.respond(requestId, type, { ok: false, error: { code: "unavailable", message: "workspace baseline not ready yet" } });
        return this.relay.respond(requestId, type, { ok: true, data: ws });
      }
      case "host.listDirectory": {
        // 直接读本机文件系统（DSH 部署常挂 native 目录选择器，远程 browse API 不可用）。
        // 与 DSH browse 语义一致：只返回子目录（含目录符号链接），最多 1000 条。
        const home = homedir();
        const target = resolve(payload?.path ?? home);
        try {
          const dir = await opendir(target);
          const names = [];
          // for await 完成后 Node 会自动关闭目录句柄；不要再手动 close（否则抛 ERR_DIR_CLOSED）
          for await (const dirent of dir) {
            if (dirent.isDirectory() || dirent.isSymbolicLink()) names.push(dirent.name);
          }
          names.sort((a, b) => a.localeCompare(b));
          const entries = [];
          let truncated = false;
          for (const name of names) {
            let enterable = false;
            try {
              const st = await stat(join(target, name));
              enterable = st.isDirectory();
            } catch { /* 损坏的符号链接等：跳过 */ }
            if (!enterable) continue;
            if (entries.length >= 1000) { truncated = true; break; }
            entries.push({ name, path: join(target, name), hidden: name.startsWith(".") });
          }
          return this.relay.respond(requestId, type, {
            ok: true,
            data: { path: target, home, crumbs: ancestryCrumbs(target), entries, truncated },
          });
        } catch (error) {
          return this.relay.respond(requestId, type, {
            ok: false,
            error: { code: "directory-unreadable", message: `cannot list ${target}: ${error?.message ?? error}`, details: {} },
          });
        }
      }
      case "host.listDrives": {
        // 「此电脑」层级：本机探测存在的盘符
        const letters = "ABCDEFGHIJKLMNOPQRSTUVWXYZ".split("");
        const results = await Promise.all(letters.map(async (letter) => {
          try {
            const st = await stat(`${letter}:\\`);
            return st.isDirectory() ? `${letter}:\\` : null;
          } catch {
            return null;
          }
        }));
        const drives = results.filter(Boolean);
        return this.relay.respond(requestId, type, { ok: true, data: { drives } });
      }
      default:
        return this.relay.respond(requestId, type, { ok: false, error: { code: "UNSUPPORTED", message: type } });
    }
  }

  async #write(type, payload, requestId) {
    switch (type) {
      case "sessions.markSeen": {
        // 清除「完成未查看」标记（绿点）：手机端打开会话后调用
        const { sessionId } = payload ?? {};
        if (typeof sessionId === "string") {
          this.completedSessions.delete(sessionId);
          this.#emitSessionFlags(); // 绿点消失：实时推帧
        }
        return this.relay.respond(requestId, type, { ok: true, data: { accepted: true } });
      }
      case "sessions.create": {
        // workspaceId（优先）或 cwd。cwd 路径先尝试注册/解析工作区：
        // web 端只按工作区分组（workspace.sessionIds），cwd-only 会话必然落「未分组」——
        // workspace.create 对已存在目录幂等（不 mkdir），成功后用 workspaceId 建会话即可
        // 既在指定目录运行、又被归入同名工作区；注册失败则回退纯 cwd（功能不受影响）。
        // 盘符根目录（D:\）DSH 无法作为项目目录（EPERM），跳过注册直接让 DSH 报错；
        // 为本次新建的工作区在会话创建失败时回滚，避免留下孤儿工作区。
        const requestedCwd = typeof payload?.cwd === "string" ? payload.cwd : undefined;
        const requestedWs = typeof payload?.workspaceId === "string" ? payload.workspaceId : undefined;
        let createPayload;
        let createdWorkspaceForCwd;
        if (requestedWs) {
          createPayload = { workspaceId: requestedWs };
        } else if (requestedCwd) {
          const isDriveRoot = /^[A-Za-z]:[\\/]$/.test(requestedCwd);
          if (isDriveRoot) {
            createPayload = { cwd: requestedCwd };
          } else {
            const w = await this.dsh.unary("workspace/create", { request: { path: requestedCwd } }, { timeoutMs: 30000 });
            if (w.ok) {
              createPayload = { workspaceId: w.value.workspace.workspaceId };
              if (w.value.created) createdWorkspaceForCwd = w.value.workspace.workspaceId;
              console.log("[adapter] sessions.create: cwd mapped to workspace", w.value.workspace.workspaceId, "(created:", w.value.created + ")", "for", requestedCwd);
            } else {
              console.warn("[adapter] sessions.create: workspace/create failed, falling back to cwd:", w.error?.message);
              createPayload = { cwd: requestedCwd };
            }
          }
        } else {
          createPayload = {};
        }
        const r = await this.dsh.unary("session/create", { request: createPayload });
        if (!r.ok) {
          if (createdWorkspaceForCwd) {
            const d = await this.dsh.unary("workspace/delete", { request: { workspaceId: createdWorkspaceForCwd } }, { timeoutMs: 30000 }).catch(() => ({ ok: false }));
            console.log("[adapter] sessions.create: rolled back workspace", createdWorkspaceForCwd, "after session/create failure:", d.ok ? "ok" : (d.error?.message ?? "unreachable"));
          }
          return this.relay.respond(requestId, type, { ok: false, error: r.error });
        }
        console.log("[adapter] created session:", r.value?.sessionId, "payload:", JSON.stringify(createPayload));
        return this.relay.respond(requestId, type, { ok: true, data: r.value });
      }
      case "host.createDirectory": {
        const { path, name } = payload ?? {};
        if (typeof path !== "string" || typeof name !== "string" || name.trim() === "" || /[/\\]/.test(name)) {
          return this.relay.respond(requestId, type, { ok: false, error: { code: "bad-request", message: "path and a single-segment name are required" } });
        }
        const target = join(resolve(path), name.trim());
        try {
          await mkdir(target);
          return this.relay.respond(requestId, type, { ok: true, data: { path: target } });
        } catch (error) {
          return this.relay.respond(requestId, type, {
            ok: false,
            error: {
              code: error?.code === "EEXIST" ? "directory-exists" : "directory-create-failed",
              message: `cannot create ${target}: ${error?.message ?? error}`,
              details: {},
            },
          });
        }
      }
      case "sessions.run": {
        const { sessionId, content } = payload ?? {};
        if (typeof sessionId !== "string" || !Array.isArray(content) || content.length === 0) {
          return this.relay.respond(requestId, type, { ok: false, error: { code: "bad-request", message: "sessionId and content are required" } });
        }
        // 斜杠命令路由：恰好一个 text 块且以 / 开头 → commands/execute（实测 session.prompt 不会自动执行）
        const isSlash = content.length === 1 && content[0]?.type === "text" && typeof content[0].text === "string" && content[0].text.trim().startsWith("/");
        const run = () => isSlash
          ? this.dsh.unary("commands/execute", { agentId: sessionId, line: content[0].text.trim(), submittedAttachments: [] }, { timeoutMs: 30000 })
          : this.dsh.unary("session/prompt", { request: { requestId: randomUUID(), sessionId, mode: "queue", content } }, { timeoutMs: 30000 });
        let r = await run();
        if (!r.ok && r.error?.code === "session/not-found") {
          // DSH 释放了该会话（空白会话被清理或 host 重启）：用原 id + 原 cwd 原位重建/恢复后重试一次
          console.log("[adapter] session-not-found on run; re-ensuring session", sessionId);
          const cwd = this.sessionCwd.get(sessionId);
          const re = await this.dsh.unary("session/create", { request: { sessionId, ...(cwd ? { cwd } : {}) } }, { timeoutMs: 30000 });
          if (!re.ok) {
            return this.relay.respond(requestId, type, { ok: false, error: r.error });
          }
          r = await run();
        }
        if (!r.ok) return this.relay.respond(requestId, type, { ok: false, error: r.error });
        return this.relay.respond(requestId, type, { ok: true, data: r.value });
      }
      case "sessions.rename": {
        const { sessionId, title } = payload ?? {};
        if (typeof sessionId !== "string" || typeof title !== "string" || title.trim() === "") {
          return this.relay.respond(requestId, type, { ok: false, error: { code: "bad-request", message: "sessionId and non-blank title are required" } });
        }
        const r = await this.dsh.unary("session/rename", { request: { sessionId, title: title.trim() } }, { timeoutMs: 30000 });
        if (!r.ok) return this.relay.respond(requestId, type, { ok: false, error: r.error });
        return this.relay.respond(requestId, type, { ok: true, data: r.value });
      }
      case "sessions.fork": {
        const { sessionId } = payload ?? {};
        if (typeof sessionId !== "string") {
          return this.relay.respond(requestId, type, { ok: false, error: { code: "bad-request", message: "sessionId is required" } });
        }
        // 默认分叉点 = 最后完成的轮次（DSH atSeq 省略语义）
        const r = await this.dsh.unary("session/fork", { request: { sessionId } }, { timeoutMs: 60000 });
        if (!r.ok) return this.relay.respond(requestId, type, { ok: false, error: r.error });
        return this.relay.respond(requestId, type, { ok: true, data: r.value });
      }
      case "sessions.archive": {
        const { sessionId } = payload ?? {};
        if (typeof sessionId !== "string") {
          return this.relay.respond(requestId, type, { ok: false, error: { code: "bad-request", message: "sessionId is required" } });
        }
        const r = await this.dsh.unary("workspace/archiveSession", { request: { sessionId } }, { timeoutMs: 30000 });
        if (!r.ok) return this.relay.respond(requestId, type, { ok: false, error: r.error });
        if (Array.isArray(r.value?.archivedSessionIds)) this.archivedSessionIds = r.value.archivedSessionIds;
        return this.relay.respond(requestId, type, { ok: true, data: r.value });
      }
      case "sessions.updateQueue": {
        // 排队消息管理（web 端语义）：edit 改文本 / remove 删除 / steer 提升为插话（仅运行中、仅 next-turn 项）
        const { sessionId, itemId, action } = payload ?? {};
        if (typeof sessionId !== "string" || typeof itemId !== "string" || typeof action !== "object" || action === null) {
          return this.relay.respond(requestId, type, { ok: false, error: { code: "bad-request", message: "sessionId, itemId and action are required" } });
        }
        if (!["edit", "remove", "steer"].includes(action.kind)) {
          return this.relay.respond(requestId, type, { ok: false, error: { code: "bad-request", message: "action.kind must be edit | remove | steer" } });
        }
        const wireAction = action.kind === "edit"
          ? { kind: "edit", content: (Array.isArray(action.content) ? action.content : []).map((b) => ({ type: "text", text: String(b?.text ?? "") })) }
          : { kind: action.kind };
        const r = await this.dsh.unary("session/updateQueue", { request: { sessionId, itemId, action: wireAction } }, { timeoutMs: 30000 });
        if (!r.ok) return this.relay.respond(requestId, type, { ok: false, error: r.error });
        return this.relay.respond(requestId, type, { ok: true, data: r.value });
      }
      case "sessions.interrupt": {
        const { sessionId } = payload ?? {};
        const r = await this.dsh.unary("session/cancel", { request: { sessionId } }, { timeoutMs: 30000 });
        if (!r.ok) return this.relay.respond(requestId, type, { ok: false, error: r.error });
        return this.relay.respond(requestId, type, { ok: true, data: r.value });
      }
      case "sessions.steer": {
        // 中途介入：对运行中的会话插入引导消息（mode=steer）
        const { sessionId, content } = payload ?? {};
        if (!Array.isArray(content) || content.length === 0) {
          return this.relay.respond(requestId, type, { ok: false, error: { code: "bad-request", message: "content is required" } });
        }
        const req = () => ({ request: { requestId: randomUUID(), sessionId, mode: "steer", content } });
        let r = await this.dsh.unary("session/prompt", req(), { timeoutMs: 30000 });
        if (!r.ok && r.error?.code === "session/not-found") {
          const cwd = this.sessionCwd.get(sessionId);
          const re = await this.dsh.unary("session/create", { request: { sessionId, ...(cwd ? { cwd } : {}) } }, { timeoutMs: 30000 });
          if (!re.ok) return this.relay.respond(requestId, type, { ok: false, error: r.error });
          r = await this.dsh.unary("session/prompt", req(), { timeoutMs: 30000 });
        }
        if (!r.ok) return this.relay.respond(requestId, type, { ok: false, error: r.error });
        return this.relay.respond(requestId, type, { ok: true, data: r.value });
      }
      case "session.selectModel": {
        const { sessionId, provider, model, reasoningEffort } = payload ?? {};
        if (typeof sessionId !== "string" || typeof provider !== "string" || typeof model !== "string") {
          return this.relay.respond(requestId, type, { ok: false, error: { code: "bad-request", message: "sessionId/provider/model are required" } });
        }
        const r = await this.dsh.unary("session/selectModel", {
          request: {
            sessionId, provider, model,
            ...(typeof reasoningEffort === "string" ? { reasoningEffort } : {}),
          },
        }, { timeoutMs: 30000 });
        if (!r.ok) return this.relay.respond(requestId, type, { ok: false, error: r.error });
        return this.relay.respond(requestId, type, { ok: true, data: r.value });
      }
      case "commands.execute": {
        // DSH 斜杠命令（/plan、/permission 等）走 commands/execute 通道
        const { sessionId, line } = payload ?? {};
        if (typeof sessionId !== "string" || typeof line !== "string" || !line.startsWith("/")) {
          return this.relay.respond(requestId, type, { ok: false, error: { code: "bad-request", message: "sessionId and line (starting with /) are required" } });
        }
        const r = await this.dsh.unary("commands/execute", { agentId: sessionId, line, submittedAttachments: [] }, { timeoutMs: 30000 });
        if (!r.ok) return this.relay.respond(requestId, type, { ok: false, error: r.error });
        return this.relay.respond(requestId, type, { ok: true, data: r.value });
      }
      case "approvals.respond": {
        const { approvalId, outcome, rpcId, sessionId } = payload ?? {};
        if (!rpcId) return this.relay.respond(requestId, type, { ok: false, error: { code: "bad-request", message: "rpcId (waterfall eventId) is required" } });
        // 新版审批：$events/result 上报瀑布监听器返回值（'allowed-once' | 'rejected'）
        const value = outcome === "rejected" ? "rejected" : "allowed-once";
        const r = await this.#answerEvent(rpcId, value);
        if (!r.ok) return this.relay.respond(requestId, type, { ok: false, error: r.error });
        if (typeof sessionId === "string") this.clearPendingRequest(rpcId, sessionId);
        return this.relay.respond(requestId, type, { ok: true, data: { accepted: true } });
      }
      case "questions.respond": {
        const { sessionId, answer, rpcId, cancel } = payload ?? {};
        if (!rpcId) return this.relay.respond(requestId, type, { ok: false, error: { code: "bad-request", message: "rpcId (waterfall eventId) is required" } });
        // cancel=true：跳过整个提问批次（全部问题回空选中，等价旧语义 ok:false + cancelled）
        let value = answer;
        if (cancel) {
          const stash = this.waterfallStash.get(rpcId);
          const questions = Array.isArray(stash?.request?.questions) ? stash.request.questions : [];
          value = { answers: questions.map((q) => ({ id: q?.id, selected: [] })) };
        }
        const r = await this.#answerEvent(rpcId, value);
        if (!r.ok) return this.relay.respond(requestId, type, { ok: false, error: r.error });
        if (typeof sessionId === "string") this.clearPendingRequest(rpcId, sessionId);
        return this.relay.respond(requestId, type, { ok: true, data: { accepted: true } });
      }
      default:
        return this.relay.respond(requestId, type, { ok: false, error: { code: "UNSUPPORTED", message: type } });
    }
  }

  /** $events 瀑布应答：经 $events/result unary 回报监听器返回值。 */
  async #answerEvent(eventId, value) {
    if (!this.eventsClientId) {
      return { ok: false, error: { code: "events-unavailable", message: "$events stream not ready (no clientId)" } };
    }
    return this.dsh.unary("$events/result", {
      clientId: this.eventsClientId,
      eventId,
      outcome: { kind: "result", value },
    }, { timeoutMs: 30000 });
  }

  /** 应答成功后清除对应的暂存请求（question/requested 或 approval/requested）。 */
  clearPendingRequest(rpcId, sessionId) {
    const stash = this.pendingRequests.get(sessionId);
    if (!stash) return;
    const kept = stash.filter((e) => e.rpcId !== rpcId);
    if (kept.length) this.pendingRequests.set(sessionId, kept); else this.pendingRequests.delete(sessionId);
    this.waterfallStash.delete(rpcId);
    this.#emitSessionFlags(); // 黄点消失：实时推帧
  }

  // 端点用点号名、payload 裸传；事件走 events.mux/host；审批/提问走 /api/respond。




















}
