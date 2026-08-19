// relay 信封 ↔ DSH API 适配器。写权限模型：进入会话即可对话（与桌面 GUI 一致）。
import { createHash, randomUUID } from "node:crypto";
import { createWriteStream } from "node:fs";
import { mkdir, opendir, rename, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

const READ_ONLY_TYPES = new Set(["sessions.list", "sessions.history", "session.models", "commands.list", "events.subscribe", "events.unsubscribe", "workspace.list", "host.listDirectory", "host.listDrives"]);
const WRITE_TYPES = new Set(["sessions.create", "sessions.run", "sessions.interrupt", "sessions.steer", "session.selectModel", "commands.execute", "approvals.respond", "questions.respond", "sessions.rename", "sessions.fork", "sessions.archive", "sessions.updateQueue", "host.createDirectory"]);

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

/**
 * history wire 投影：剥离 UI 不渲染的海量流式碎片（assistant/chunk、step/*），
 * 截断超长工具输出。4.3MB 大会话压到 ~50KB，解决服务器 1Mbps 带宽下的传输瓶颈。
 */
function compactHistoryEvents(events) {
  const kept = [];
  for (const entry of events) {
    const t = entry?.event?.type;
    if (t === "assistant/chunk" || t === "step/start" || t === "step/end") continue;
    if (t === "tool/result") {
      // 截断到 500 字符：远程只做预览展示，完整内容在桌面端
      const copy = { seq: entry.seq, event: { type: t, data: { ...entry.event.data } } };
      const content = copy.event.data?.message?.content;
      if (Array.isArray(content)) {
        copy.event.data.message = { ...copy.event.data.message, content: content.map((b) => b.type === "text" && typeof b.text === "string" && b.text.length > 500 ? { ...b, text: b.text.slice(0, 500) + "\n…[截断]" } : b) };
      }
      kept.push(copy);
      continue;
    }
    kept.push(entry);
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
  constructor({ dsh, relay, workspaceRoot }) {
    this.dsh = dsh;
    this.relay = relay;
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
    // 归档集合缓存（workspace.list + host/archived-sessions-changed 更新）
    this.archivedSessionIds = [];
    // sessionId -> 最近一次 session/queue 帧（客户端订阅时重放，保证 QueueDock 状态不丢）
    this.queueFrames = new Map();
  }

  /** relay 请求入口。envelope: canonical request。 */
  async handleRequest(env) {
    const { requestId, type, payload = {} } = env;
    if (typeof requestId !== "string") return;
    console.log("[adapter] request:", type, "from", env.actor?.clientId ?? "?", "payload:", JSON.stringify(payload).slice(0, 400));

    if (type === "transfer.deliver") return this.#deliver(payload, requestId);

    if (READ_ONLY_TYPES.has(type)) return this.#read(type, payload, requestId);
    if (WRITE_TYPES.has(type)) return this.#write(type, payload, requestId);

    this.relay.respond(requestId, type, {
      ok: false,
      error: { code: "UNSUPPORTED", message: `message type '${type}' is not implemented by this bridge` },
    });
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

  async #read(type, payload, requestId) {
    switch (type) {
      case "sessions.list": {
        // 并行取归档集合：手机端用它把归档会话从主列表里收起
        const [r, w] = await Promise.all([
          this.dsh.unary("session.list", {}),
          this.dsh.unary("workspace.list", {}).catch(() => ({ ok: false })),
        ]);
        if (!r.ok) return this.relay.respond(requestId, type, { ok: false, error: r.error });
        if (w.ok && Array.isArray(w.value?.archivedSessionIds)) this.archivedSessionIds = w.value.archivedSessionIds;
        // 缓存 cwd：session 被 DSH 释放后可用 session.create {sessionId, cwd} 原位恢复
        for (const s of r.value.items ?? []) {
          if (typeof s.sessionId === "string" && typeof s.cwd === "string") this.sessionCwd.set(s.sessionId, s.cwd);
        }
        return this.relay.respond(requestId, type, { ok: true, data: { sessions: r.value.items, archivedSessionIds: [...this.archivedSessionIds] } });
      }
      case "sessions.history": {
        const { sessionId, beforeSeq, maxMessages } = payload;
        if (typeof sessionId !== "string") return this.relay.respond(requestId, type, { ok: false, error: { code: "bad-request", message: "sessionId is required" } });
        // 默认只取最近 20 条消息；上限 100 防止大会话打爆中继
        const capped = Math.min(Math.max(1, Number.isInteger(maxMessages) ? maxMessages : 10), 100);
        const t0 = Date.now();
        const r = await this.dsh.unary("session.history", {
          sessionId,
          ...(Number.isInteger(beforeSeq) ? { beforeSeq } : {}),
          maxMessages: capped,
        }, { timeoutMs: 60000 });
        console.log("[adapter] history unary done in", Date.now() - t0, "ms, ok=", r.ok, "events=", r.value?.events?.length);
        if (!r.ok) return this.relay.respond(requestId, type, { ok: false, error: r.error });
        // wire 投影：压缩体积（chunk 碎片是大会话 4MB+ 的主要来源）
        const compacted = compactHistoryEvents(r.value.events ?? []);
        // DSH 条目的 seq 在 event 信封内；补到顶层作为客户端分页游标（beforeSeq）
        const wire = compacted.map((entry) => {
          const event = entry?.event ?? entry;
          return { ...entry, event, seq: event?.seq ?? entry?.seq };
        });
        const dropped = (r.value.events?.length ?? 0) - wire.length;
        // projections 块（sessionStats/tokenUsage/contextPressure 等）原样透传，供客户端渲染统计条
        const data = { events: wire, hasMore: r.value.hasMore };
        if (r.value.projections) data.projections = r.value.projections;
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
        const r = await this.dsh.unary("session.models", { sessionId }, { timeoutMs: 30000 });
        if (!r.ok) return this.relay.respond(requestId, type, { ok: false, error: r.error });
        return this.relay.respond(requestId, type, { ok: true, data: r.value });
      }
      case "commands.list": {
        const { sessionId } = payload;
        if (typeof sessionId !== "string") return this.relay.respond(requestId, type, { ok: false, error: { code: "bad-request", message: "sessionId is required" } });
        const r = await this.dsh.unary("commands/list", { args: { agentId: sessionId } }, { timeoutMs: 30000 });
        if (!r.ok) return this.relay.respond(requestId, type, { ok: false, error: r.error });
        return this.relay.respond(requestId, type, { ok: true, data: { commands: r.value } });
      }
      case "workspace.list": {
        // 工作区列表：新建会话时选目录用（手机端目录选择，无需推送目录）
        const r = await this.dsh.unary("workspace.list", {}, { timeoutMs: 30000 });
        if (!r.ok) return this.relay.respond(requestId, type, { ok: false, error: r.error });
        return this.relay.respond(requestId, type, { ok: true, data: r.value });
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
            const w = await this.dsh.unary("workspace.create", { path: requestedCwd }, { timeoutMs: 30000 });
            if (w.ok) {
              createPayload = { workspaceId: w.value.workspace.workspaceId };
              if (w.value.created) createdWorkspaceForCwd = w.value.workspace.workspaceId;
              console.log("[adapter] sessions.create: cwd mapped to workspace", w.value.workspace.workspaceId, "(created:", w.value.created + ")", "for", requestedCwd);
            } else {
              console.warn("[adapter] sessions.create: workspace.create failed, falling back to cwd:", w.error?.message);
              createPayload = { cwd: requestedCwd };
            }
          }
        } else {
          createPayload = {};
        }
        const r = await this.dsh.unary("session.create", createPayload);
        if (!r.ok) {
          if (createdWorkspaceForCwd) {
            const d = await this.dsh.unary("workspace.delete", { workspaceId: createdWorkspaceForCwd }, { timeoutMs: 30000 }).catch(() => ({ ok: false }));
            console.log("[adapter] sessions.create: rolled back workspace", createdWorkspaceForCwd, "after session.create failure:", d.ok ? "ok" : (d.error?.message ?? "unreachable"));
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
          ? this.dsh.unary("commands/execute", { args: { agentId: sessionId, line: content[0].text.trim() } }, { timeoutMs: 30000 })
          : this.dsh.unary("session.prompt", { sessionId, mode: "queue", content }, { timeoutMs: 30000 });
        let r = await run();
        if (!r.ok && r.error?.code === "session-not-found") {
          // DSH 释放了该会话（空白会话被清理或 host 重启）：用原 id + 原 cwd 原位重建/恢复后重试一次
          console.log("[adapter] session-not-found on run; re-ensuring session", sessionId);
          const cwd = this.sessionCwd.get(sessionId);
          const re = await this.dsh.unary("session.create", { sessionId, ...(cwd ? { cwd } : {}) }, { timeoutMs: 30000 });
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
        const r = await this.dsh.unary("session.rename", { sessionId, title: title.trim() }, { timeoutMs: 30000 });
        if (!r.ok) return this.relay.respond(requestId, type, { ok: false, error: r.error });
        return this.relay.respond(requestId, type, { ok: true, data: r.value });
      }
      case "sessions.fork": {
        const { sessionId } = payload ?? {};
        if (typeof sessionId !== "string") {
          return this.relay.respond(requestId, type, { ok: false, error: { code: "bad-request", message: "sessionId is required" } });
        }
        // 默认分叉点 = 最后完成的轮次（DSH atSeq 省略语义）
        const r = await this.dsh.unary("session.fork", { sessionId }, { timeoutMs: 60000 });
        if (!r.ok) return this.relay.respond(requestId, type, { ok: false, error: r.error });
        return this.relay.respond(requestId, type, { ok: true, data: r.value });
      }
      case "sessions.archive": {
        const { sessionId } = payload ?? {};
        if (typeof sessionId !== "string") {
          return this.relay.respond(requestId, type, { ok: false, error: { code: "bad-request", message: "sessionId is required" } });
        }
        const r = await this.dsh.unary("workspace.archiveSession", { sessionId }, { timeoutMs: 30000 });
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
        const r = await this.dsh.unary("session.updateQueue", { sessionId, itemId, action: wireAction }, { timeoutMs: 30000 });
        if (!r.ok) return this.relay.respond(requestId, type, { ok: false, error: r.error });
        return this.relay.respond(requestId, type, { ok: true, data: r.value });
      }
      case "sessions.interrupt": {
        const { sessionId, reason } = payload ?? {};
        const r = await this.dsh.unary("session.cancel", { sessionId, reason: typeof reason === "string" ? reason : "remote interrupt" }, { timeoutMs: 30000 });
        if (!r.ok) return this.relay.respond(requestId, type, { ok: false, error: r.error });
        return this.relay.respond(requestId, type, { ok: true, data: r.value });
      }
      case "sessions.steer": {
        // 中途介入：对运行中的会话插入引导消息（mode=steer）
        const { sessionId, content } = payload ?? {};
        if (!Array.isArray(content) || content.length === 0) {
          return this.relay.respond(requestId, type, { ok: false, error: { code: "bad-request", message: "content is required" } });
        }
        let r = await this.dsh.unary("session.prompt", { sessionId, mode: "steer", content }, { timeoutMs: 30000 });
        if (!r.ok && r.error?.code === "session-not-found") {
          const cwd = this.sessionCwd.get(sessionId);
          const re = await this.dsh.unary("session.create", { sessionId, ...(cwd ? { cwd } : {}) }, { timeoutMs: 30000 });
          if (!re.ok) return this.relay.respond(requestId, type, { ok: false, error: r.error });
          r = await this.dsh.unary("session.prompt", { sessionId, mode: "steer", content }, { timeoutMs: 30000 });
        }
        if (!r.ok) return this.relay.respond(requestId, type, { ok: false, error: r.error });
        return this.relay.respond(requestId, type, { ok: true, data: r.value });
      }
      case "session.selectModel": {
        const { sessionId, provider, model, reasoningEffort } = payload ?? {};
        if (typeof sessionId !== "string" || typeof provider !== "string" || typeof model !== "string") {
          return this.relay.respond(requestId, type, { ok: false, error: { code: "bad-request", message: "sessionId/provider/model are required" } });
        }
        const r = await this.dsh.unary("session.selectModel", {
          sessionId, provider, model,
          ...(typeof reasoningEffort === "string" ? { reasoningEffort } : {}),
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
        const r = await this.dsh.unary("commands/execute", { args: { agentId: sessionId, line } }, { timeoutMs: 30000 });
        if (!r.ok) return this.relay.respond(requestId, type, { ok: false, error: r.error });
        return this.relay.respond(requestId, type, { ok: true, data: r.value });
      }
      case "approvals.respond": {
        const { sessionId, approvalId, outcome, rpcId } = payload ?? {};
        if (!rpcId) return this.relay.respond(requestId, type, { ok: false, error: { code: "bad-request", message: "rpcId (server-request id) is required" } });
        const r = await this.dsh.respond(rpcId, { sessionId, approvalId, outcome: outcome === "rejected" ? "rejected" : "allowed-once" });
        if (!r.ok) return this.relay.respond(requestId, type, { ok: false, error: r.error });
        if (typeof sessionId === "string") this.clearPendingRequest(rpcId, sessionId);
        return this.relay.respond(requestId, type, { ok: true, data: { accepted: true } });
      }
      case "questions.respond": {
        const { sessionId, answer, rpcId, cancel } = payload ?? {};
        if (!rpcId) return this.relay.respond(requestId, type, { ok: false, error: { code: "bad-request", message: "rpcId (server-request id) is required" } });
        // cancel=true：跳过整个提问批次（DSH 语义 = ok:false + code cancelled）
        const r = cancel
          ? await this.dsh.respond(rpcId, undefined, { cancel: true })
          : await this.dsh.respond(rpcId, { sessionId, answer });
        if (!r.ok) return this.relay.respond(requestId, type, { ok: false, error: r.error });
        if (typeof sessionId === "string") this.clearPendingRequest(rpcId, sessionId);
        return this.relay.respond(requestId, type, { ok: true, data: { accepted: true } });
      }
      default:
        return this.relay.respond(requestId, type, { ok: false, error: { code: "UNSUPPORTED", message: type } });
    }
  }

  /** DSH mux 帧 → relay 事件。只转发已订阅会话，避免未打开的桌面会话内容外泄。
   *  提问/审批帧在无人订阅时暂存，客户端订阅后重放（见 events.subscribe）。
   *  与 history 投影一致：剥离 assistant/chunk、step/* 流式碎片——手机不渲染它们，
   *  大会话的 chunk 洪峰（数万帧/分钟）会把手机端 20s ping/pong 挤超时导致断连循环。 */
  handleMuxFrame(frame) {
    const p = frame?.payload;
    if (!p || typeof p.type !== "string") return;
    if (p.type === "stream/error") { console.warn("[dsh] mux stream error:", p.error?.message); return; }
    const sid = p.sessionId;

    // 待应答请求的暂存/清除
    if (typeof sid === "string") {
      if (p.type === "question/requested" || p.type === "approval/requested") {
        const entry = { rpcId: frame.rpcId, payload: p };
        const stash = this.pendingRequests.get(sid) ?? [];
        const idx = stash.findIndex((e) => e.rpcId === frame.rpcId && e.payload.type === p.type);
        if (idx >= 0) stash[idx] = entry; else stash.push(entry);
        this.pendingRequests.set(sid, stash);
      } else if (p.type === "question/resolved" || p.type === "approval/resolved") {
        // 解析帧不带原 rpcId：按会话清空该类暂存
        const kind = p.type === "question/resolved" ? "question/requested" : "approval/requested";
        const stash = this.pendingRequests.get(sid) ?? [];
        const kept = stash.filter((e) => e.payload.type !== kind);
        if (kept.length) this.pendingRequests.set(sid, kept); else this.pendingRequests.delete(sid);
      } else if (p.type === "session/queue") {
        // 收件箱快照：客户端订阅/重连后重放，保证排队信息条（QueueDock）状态不丢
        this.queueFrames.set(sid, p);
      }
    }

    // 流式碎片不转发（客户端不渲染；防止洪峰打爆弱网）
    if (p.type === "session/event") {
      const et = p.event?.type;
      if (et === "assistant/chunk" || et === "step/start" || et === "step/end") {
        this._chunkDropped = (this._chunkDropped ?? 0) + 1;
        if (this._chunkDropped % 500 === 1) console.log("[adapter] live chunks dropped (unrendered):", this._chunkDropped);
        return;
      }
    }

    if (typeof sid === "string" && !this.subscribed.has(sid)) {
      // 只对命中率做日志采样：未订阅帧每 50 条打一条
      this._unsubCount = (this._unsubCount ?? 0) + 1;
      if (this._unsubCount % 50 === 1) console.log("[adapter] mux frame filtered (unsubscribed), type:", p.type, "count:", this._unsubCount);
      return;
    }
    this.relay.forwardEvent({
      sessionId: typeof sid === "string" ? sid : undefined,
      frame: p,
      rpcId: frame.rpcId,
    });
  }

  /** 应答成功后清除对应的暂存请求（question/requested 或 approval/requested）。 */
  clearPendingRequest(rpcId, sessionId) {
    const stash = this.pendingRequests.get(sessionId);
    if (!stash) return;
    const kept = stash.filter((e) => e.rpcId !== rpcId);
    if (kept.length) this.pendingRequests.set(sessionId, kept); else this.pendingRequests.delete(sessionId);
  }

  /** DSH host 帧：session-added/removed/status 对全部客户端广播（元数据，不泄露内容）。 */
  handleHostFrame(frame) {
    const p = frame?.payload;
    if (!p || typeof p.type !== "string") return;
    if (p.type === "host/archived-sessions-changed" && Array.isArray(p.archivedSessionIds)) {
      this.archivedSessionIds = p.archivedSessionIds;
    }
    if (["host/session-added", "host/session-removed", "host/session-status", "host/archived-sessions-changed"].includes(p.type)) {
      this.relay.forwardEvent({ frame: p, rpcId: frame.rpcId });
    }
  }
}
