// relay 信封 ↔ DSH API 适配器。写权限模型：进入会话即可对话（与桌面 GUI 一致）。
import { createHash, randomUUID } from "node:crypto";
import { appendFileSync, createWriteStream } from "node:fs";
import { mkdir, opendir, open, readFile, rename, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

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
    // 归档集合缓存（workspace.list + host/archived-sessions-changed 更新）
    this.archivedSessionIds = [];
    // sessionId -> 最近一次 session/queue 帧（客户端订阅时重放，保证 QueueDock 状态不丢）
    this.queueFrames = new Map();
    // App 内提醒：sessionId -> 有「已完成但未查看」的对话（绿点）
    this.completedSessions = new Set();
    // 当前回合出过 assistant 消息的会话（用于区分 turn/end 是「完成」还是「等待审批/提问」）
    this.turnProducedResponse = new Set();
  }

  /** relay 请求入口。envelope: canonical request。 */
  async handleRequest(env) {
    const { requestId, type, payload = {} } = env;
    if (typeof requestId !== "string") return;
    console.log("[adapter] request:", type, "from", env.actor?.clientId ?? "?", "payload:", JSON.stringify(payload).slice(0, 400));

    if (type === "transfer.deliver") return this.#deliver(payload, requestId);
    if (type === "upload.commit") return this.#commitUpload(payload, requestId);
    if (type === "attachment.resolve") return this.#resolveAttachment(payload, requestId);
    if (type === "key.exchange") return this.#keyExchange(payload, requestId);
    if (type === "e2ee.hello") return this.#e2eeHello(payload, requestId);

    if (READ_ONLY_TYPES.has(type)) return this.#read(type, payload, requestId);
    if (WRITE_TYPES.has(type)) return this.#write(type, payload, requestId);

    this.relay.respond(requestId, type, {
      ok: false,
      error: { code: "UNSUPPORTED", message: `message type '${type}' is not implemented by this bridge` },
    });
  }

  /** E2EE 配对握手：按 pairingId 查 secret，校验 phone auth，pin 其身份公钥。 */
  #keyExchange(payload, requestId) {
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
    return this.relay.respond(requestId, "key.exchange", { ok: true, data: r.data });
  }

  /** E2EE 每连接 hello：派生本连接密钥，回本端 keyId+cNonce。 */
  #e2eeHello(payload, requestId) {
    const fail = (code, message) =>
      this.relay.respond(requestId, "e2ee.hello", { ok: false, error: { code, message } });
    if (!this.e2ee) return fail("disabled", "e2ee not available");
    if (typeof payload?.keyId !== "string" || typeof payload?.cNonce !== "string") {
      return fail("bad-request", "keyId/cNonce required");
    }
    const hello = this.e2ee.beginConnection();
    if (!this.e2ee.establishConnection({ peerKeyIdHex: payload.keyId, peerCNonceB64url: payload.cNonce })) {
      e2eeDebug(`e2ee.hello keyId=${payload.keyId} -> FAIL(key-mismatch, pinned=${this.e2ee.pinnedPeer?.keyId})`);
      return fail("key-mismatch", "peer keyId does not match pinned key");
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
  /** 单次 session.prompt（queue 模式），带会话释放后的原位重建重试。 */
  async #promptOnce(sessionId, content) {
    let r = await this.dsh.unary(
      "session.prompt",
      { sessionId, mode: "queue", content },
      { timeoutMs: 30000 },
    );
    if (!r.ok && r.error?.code === "session-not-found") {
      // 与 sessions.run 同款重保障：DSH 释放会话后按原 cwd 原位重建再重试一次
      const cwd = this.sessionCwd.get(sessionId);
      const re = await this.dsh.unary(
        "session.create",
        { sessionId, ...(cwd ? { cwd } : {}) },
        { timeoutMs: 30000 },
      );
      if (re.ok) {
        r = await this.dsh.unary(
          "session.prompt",
          { sessionId, mode: "queue", content },
          { timeoutMs: 30000 },
        );
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
      const r = await this.dsh.unary("session.attachment", { sessionId, attachmentId }, { timeoutMs: 30000 });
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
        return this.relay.respond(requestId, type, {
          ok: true,
          data: {
            sessions: r.value.items,
            archivedSessionIds: [...this.archivedSessionIds],
            // App 内提醒：绿点（完成未查看）/ 黄点（等待审批或提问）
            completedSessionIds: [...this.completedSessions],
            pendingSessionIds: [...this.pendingRequests.keys()],
          },
        });
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
      case "sessions.markSeen": {
        // 清除「完成未查看」标记（绿点）：手机端打开会话后调用
        const { sessionId } = payload ?? {};
        if (typeof sessionId === "string") this.completedSessions.delete(sessionId);
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
          ? this.dsh.unary("commands/execute", { args: { agentId: sessionId, line: content[0].text.trim(), images: [] } }, { timeoutMs: 30000 })
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
        const r = await this.dsh.unary("commands/execute", { args: { agentId: sessionId, line, images: [] } }, { timeoutMs: 30000 });
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
      // App 内提醒：跟踪回合是否产出最终回复，区分「完成(绿)」与「等待审批/提问(黄)」
      if (typeof sid === "string") {
        if (et === "turn/start") this.turnProducedResponse.delete(sid);
        else if (et === "assistant/message") this.turnProducedResponse.add(sid);
        else if (et === "turn/end") {
          if (this.turnProducedResponse.has(sid)) {
            this.completedSessions.add(sid);
            this.turnProducedResponse.delete(sid);
          }
        }
      }
      if (et === "assistant/chunk" || et === "step/start" || et === "step/end") {
        this._chunkDropped = (this._chunkDropped ?? 0) + 1;
        if (this._chunkDropped % 500 === 1) console.log("[adapter] live chunks dropped (unrendered):", this._chunkDropped);
        return;
      }
    }

    // 移除 subscribed 过滤：订阅态在 bridge 进程重启后会丢失，导致会话事件被过滤，
    // 手机端出现「发送后不显示」+「绿点残留」。改为转发该设备全部会话事件；
    // 手机端已按 sessionId 过滤（只渲染当前会话），多余事件自然丢弃。
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
