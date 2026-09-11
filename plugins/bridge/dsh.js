// DSH 本地 API 客户端（新版 v0.1.5+ 协议）：
//   鉴权：进程 launch token → 一次性换会话 Cookie（HMAC 签名、绑定 Host、30 天有效），
//         之后所有 /api 请求与 WS 升级都带该 Cookie；401 时自动重铸一次。
//   unary：POST /api/<endpoint>，信封 {type:"client-request", rpcId, method, payload:{args}}。
//   流：单一 WebSocket /api/remote.mux，逻辑流帧 open/item/end/error/cancel 复用。
// 兼容老版 DSH（无鉴权）：没有 token 时不带 Cookie 直连（老服务端不校验）。
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

  /** unary：POST /api/<endpoint>；args 为 typert wire 参数对象（如 {_request:{}} / {request:{...}} / {agentId}）。 */
  async unary(endpoint, args = {}, { timeoutMs = 30000 } = {}) {
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

  /**
   * 打开（或换新）一条到 /api/remote.mux 的物理连接。
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
