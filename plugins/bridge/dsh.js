// DSH 本地 API 客户端（双协议）：
//   v2（DSH v0.1.5+）：launch token → 会话 Cookie（HMAC、30 天）→ POST /api/<ns/method> {args} 载荷；
//           流走单一 WS /api/remote.mux（open/item/end/error/cancel 复用）。
//   legacy（老版 DSH）：无鉴权直连，POST /api/<method>（点号端点、裸 payload）；
//           流走 /api/events.mux + /api/events.host，审批/提问走 /api/respond。
//   协议在首次调用时自动探测（v2 探针 401=新版鉴权；双探针都要求 ok:true 防误判）。
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export class DshClient {
  constructor(baseUrl, { stateDir, token } = {}) {
    this.baseUrl = baseUrl.replace(/\/$/, "");
    this.token = token ?? "";
    this.stateDir = stateDir ?? null;
    this.cookie = this.#loadCookie(); // { name, value, expiresAt }
    this.mux = null;
    this.protocol = null; // "v2" | "legacy"（ensureProtocol() 探测后确定）
  }

  /** 探测并确定协议代际；DSH 未就绪/双探针失败时抛错（调用方退避重试）。 */
  async ensureProtocol() {
    if (this.protocol) return this.protocol;
    let status = await this.#v2Probe();
    if (status === "auth-required") {
      // 新版 DSH 才有鉴权；有 token 就换 Cookie 再确认，没有也按 v2 处理
      try {
        const cookie = await this.cookieHeader();
        if (cookie) status = await this.#v2Probe();
      } catch {
        /* token 缺失：保持 auth-required */
      }
    }
    if (status === "v2" || status === "auth-required") {
      this.protocol = "v2";
      return "v2";
    }
    if (await this.#legacyProbe()) {
      this.protocol = "legacy";
      return "legacy";
    }
    throw new Error("dsh protocol probe failed (dsh web not reachable?)");
  }

  /** v2 探针：POST /api/session/list。401→"auth-required"；ok:true 且 items 为数组→"v2"；否则 null。 */
  async #v2Probe() {
    try {
      const rpcId = randomUUID();
      const headers = { "content-type": "application/json" };
      if (this.cookie) headers.cookie = `${this.cookie.name}=${this.cookie.value}`;
      const res = await fetch(`${this.baseUrl}/api/session/list`, {
        method: "POST",
        headers,
        body: JSON.stringify({ type: "client-request", rpcId, method: "session/list", payload: { args: { _request: {} } } }),
        signal: AbortSignal.timeout(5000),
      });
      if (res.status === 401) return "auth-required";
      const body = await res.json().catch(() => null);
      if (body?.type === "server-response" && body.rpcId === rpcId && body.result?.ok === true && Array.isArray(body.result.value?.items)) return "v2";
      return null;
    } catch {
      return null;
    }
  }

  /** legacy 探针：POST /api/session.list（点号端点）。要求 ok:true（新 DSH 会对该端点回 ok:false 错误信封）。 */
  async #legacyProbe() {
    try {
      const rpcId = randomUUID();
      const res = await fetch(`${this.baseUrl}/api/session.list`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ type: "client-request", rpcId, method: "session.list", payload: {} }),
        signal: AbortSignal.timeout(5000),
      });
      const body = await res.json().catch(() => null);
      return body?.type === "server-response" && body.rpcId === rpcId && body.result?.ok === true;
    } catch {
      return false;
    }
  }

  setToken(token) {
    if (token && token !== this.token) {
      this.token = token;
      this.cookie = null;
    }
  }

  #cookieFile() {
    return this.stateDir ? join(this.stateDir, "dsh-auth-cookie.json") : null;
  }

  #loadCookie() {
    try {
      const f = this.#cookieFile();
      if (!f || !existsSync(f)) return null;
      const c = JSON.parse(readFileSync(f, "utf8"));
      if (c?.name && c?.value && Number.isFinite(c.expiresAt) && c.expiresAt > Date.now() + 60_000) return c;
    } catch {
      /* 坏缓存当作无缓存 */
    }
    return null;
  }

  #saveCookie(c) {
    try {
      const f = this.#cookieFile();
      if (f) {
        mkdirSync(this.stateDir, { recursive: true });
        writeFileSync(f, JSON.stringify(c));
      }
    } catch {
      /* 缓存失败不致命 */
    }
  }

  /** 用 launch token 换会话 Cookie：GET /?token=…（redirect: manual）→ 303 + Set-Cookie。 */
  async #mintCookie() {
    if (!this.token) throw new Error("dsh auth: no launch token available");
    const res = await fetch(`${this.baseUrl}/?token=${encodeURIComponent(this.token)}`, {
      redirect: "manual",
    });
    let header = null;
    try {
      const setCookies = typeof res.headers.getSetCookie === "function" ? res.headers.getSetCookie() : [];
      header = setCookies.find((c) => c.startsWith("dsh-auth-"));
    } catch {
      /* 继续 fallback */
    }
    if (!header) {
      const single = res.headers.get("set-cookie");
      if (typeof single === "string" && single.startsWith("dsh-auth-")) header = single;
    }
    if (!header) {
      throw new Error(`dsh auth: token exchange returned no dsh-auth cookie (HTTP ${res.status})`);
    }
    const pair = header.split(";", 1)[0];
    const eq = pair.indexOf("=");
    if (eq <= 0) throw new Error("dsh auth: malformed set-cookie from token exchange");
    const maxAge = /max-age=(\d+)/i.exec(header);
    const c = {
      name: pair.slice(0, eq),
      value: pair.slice(eq + 1),
      // 服务端默认 30 天；缓存有效期取 Max-Age，读不到则保守按 24h
      expiresAt: Date.now() + (maxAge ? Number(maxAge[1]) * 1000 : 24 * 3600e3),
    };
    this.cookie = c;
    this.#saveCookie(c);
    return c;
  }

  /** 当前应携带的 Cookie 头；无 token 且无缓存时返回 null（老版 DSH 无鉴权模式）。 */
  async cookieHeader() {
    if (this.cookie) return `${this.cookie.name}=${this.cookie.value}`;
    if (!this.token) return null;
    await this.#mintCookie();
    return `${this.cookie.name}=${this.cookie.value}`;
  }

  /** 带 Cookie 的 fetch；401 时作废缓存重铸一次再试。 */
  async #fetch(path, init = {}) {
    const once = async () => {
      const cookie = await this.cookieHeader();
      const headers = { ...(init.headers ?? {}) };
      if (cookie) headers.cookie = cookie;
      return fetch(`${this.baseUrl}${path}`, { ...init, headers });
    };
    let res = await once();
    if (res.status === 401 && this.token) {
      this.cookie = null;
      res = await once();
    }
    return res;
  }

  /** unary：首次调用自动探测协议；v2 走 {args} 载荷，legacy 走裸 payload。 */
  async unary(endpoint, args = {}, opts = {}) {
    await this.ensureProtocol();
    if (this.protocol === "legacy") return this.#legacyUnary(endpoint, args, opts);
    return this.#v2Unary(endpoint, args, opts);
  }

  /** v2 unary：POST /api/<endpoint>；args 为 typert wire 参数对象（如 {_request:{}} / {request:{...}} / {agentId}）。 */
  async #v2Unary(endpoint, args = {}, { timeoutMs = 30000 } = {}) {
    const rpcId = randomUUID();
    const res = await this.#fetch(`/api/${endpoint}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ type: "client-request", rpcId, method: endpoint, payload: { args } }),
      signal: AbortSignal.timeout(timeoutMs),
    });
    const body = await res.json().catch(() => ({}));
    if (body?.type !== "server-response" || body.rpcId !== rpcId) {
      return { ok: false, error: { code: "protocol-error", message: `unexpected response for ${endpoint}: HTTP ${res.status}` } };
    }
    return body.result;
  }

  /** legacy unary：POST /api/<method>（点号端点），payload 原样发送。 */
  async #legacyUnary(method, payload = {}, { timeoutMs = 30000 } = {}) {
    const rpcId = randomUUID();
    const res = await fetch(`${this.baseUrl}/api/${method}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ type: "client-request", rpcId, method, payload }),
      signal: AbortSignal.timeout(timeoutMs),
    });
    const body = await res.json().catch(() => ({}));
    if (body?.type !== "server-response" || body.rpcId !== rpcId) {
      return { ok: false, error: { code: "protocol-error", message: `unexpected response for ${method}: HTTP ${res.status}` } };
    }
    return body.result;
  }

  /** legacy 应答审批/提问：POST /api/respond。cancel=true 时发 ok:false + cancelled（旧 DSH 跳过语义）。 */
  async respond(rpcId, value, { timeoutMs = 30000, cancel = false } = {}) {
    const result = cancel
      ? { ok: false, error: { code: "cancelled", message: "user cancelled", details: {} } }
      : { ok: true, value };
    const res = await fetch(`${this.baseUrl}/api/respond`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ type: "client-response", rpcId, result }),
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) return { ok: false, error: { code: "transport", message: `respond HTTP ${res.status}` } };
    const body = await res.json().catch(() => ({}));
    if (body?.accepted === false) {
      return { ok: false, error: { code: "respond-rejected", message: `DSH rejected respond: ${body.reason ?? "unknown"}` } };
    }
    return { ok: true };
  }

  /** legacy 下行 WS 流；onFrame 收到 {rpcId, method, payload}；onState 收到 open/close/error。 */
  openStream(path, onFrame, onState) {
    const ws = new WebSocket(`${this.baseUrl.replace(/^http/, "ws")}${path}`);
    ws.onopen = () => onState?.("open");
    ws.onclose = () => onState?.("close");
    ws.onerror = () => onState?.("error");
    ws.onmessage = (ev) => {
      try {
        const f = JSON.parse(ev.data);
        if (f?.type === "server-request") onFrame?.(f);
      } catch {
        /* 跳过坏帧 */
      }
    };
    return ws;
  }

  /**
   * 打开（或换新）一条到 /api/remote.mux 的物理连接（v2）。
   * @param onClose 连接关闭（或打不开）时回调，主循环据此退避重连。
   */
  openMux(onClose) {
    if (this.mux && (this.mux.ws?.readyState === WebSocket.OPEN || this.mux.ws?.readyState === WebSocket.CONNECTING)) {
      try { this.mux.ws.close(); } catch { /* 换新连接 */ }
    }
    this.mux = new MuxConnection(this, onClose);
    return this.mux;
  }
}

/** 单条 WS 物理连接上的逻辑流复用（streamId 寻址）。 */
export class MuxConnection {
  #resolveReady;
  #rejectReady;

  constructor(client, onClose) {
    this.client = client;
    this.onClose = onClose;
    this.streams = new Map(); // streamId -> { onItem, onError, onEnd }
    this.ws = null;
    this.closedReason = null;
    this.#resolveReady = null;
    this.#rejectReady = null;
    this.ready = new Promise((resolve, reject) => {
      this.#resolveReady = resolve;
      this.#rejectReady = reject;
    });
    this.#connect();
  }

  async #connect() {
    try {
      const cookie = await this.client.cookieHeader();
      if (this.closedReason !== null) return;
      const headers = {};
      if (cookie) headers.cookie = cookie;
      const ws = new WebSocket(`${this.client.baseUrl.replace(/^http/, "ws")}/api/remote.mux`, { headers });
      this.ws = ws;
      ws.onopen = () => this.#resolveReady();
      ws.onclose = () => this.#closed();
      ws.onerror = () => { /* onclose 会跟着来 */ };
      ws.onmessage = (ev) => {
        let f;
        try { f = JSON.parse(ev.data); } catch { return; }
        const s = this.streams.get(f?.streamId);
        if (!s) return;
        if (f.type === "item") s.onItem?.(f.value);
        else if (f.type === "end") { this.streams.delete(f.streamId); s.onEnd?.(); }
        else if (f.type === "error") { this.streams.delete(f.streamId); s.onError?.(f.error); }
      };
    } catch (err) {
      // cookie 换发失败等：按关闭处理，让主循环退避重试
      this.#closed(err);
    }
  }

  #closed(reason) {
    if (this.closedReason !== null) return;
    this.closedReason = reason;
    const message = String(reason?.message ?? reason ?? "mux closed");
    this.#rejectReady(new Error(message));
    for (const s of this.streams.values()) s.onError?.({ code: "stream-closed", message });
    this.streams.clear();
    this.onClose?.(reason);
  }

  /** 打开一条逻辑流：发送 open 帧；返回 { streamId, cancel() }。失败时回调 onError，不抛异常。 */
  async openStream(endpoint, args = {}, { onItem, onError, onEnd } = {}) {
    const streamId = randomUUID();
    this.streams.set(streamId, { onItem, onError, onEnd });
    try {
      await this.ready;
      if (this.ws?.readyState !== WebSocket.OPEN) throw new Error(`mux socket closed for ${endpoint}`);
      this.ws.send(JSON.stringify({ type: "open", streamId, endpoint, payload: { args } }));
    } catch (err) {
      this.streams.delete(streamId);
      onError?.({ code: "stream-open-failed", message: String(err?.message ?? err) });
    }
    return {
      streamId,
      cancel: () => {
        this.streams.delete(streamId);
        if (this.ws?.readyState === WebSocket.OPEN) {
          try { this.ws.send(JSON.stringify({ type: "cancel", streamId })); } catch { /* 连接已断 */ }
        }
      },
    };
  }

  close() {
    try { this.ws?.close(); } catch { /* 忽略 */ }
  }
}
