// DSH 本地 API 客户端（**只支持 v2 / DSH v0.1.5+**；旧版 DSH 的 legacy 协议已于 0.1.0-beta.23 整体删除）：
//   v2：鉴权**由 401 决定**（1.0.7 起）——先免 cookie 直连，只有收到 401 才拿 launch token 换会话
//       Cookie（HMAC、30 天）；token 交换不可用（HTTP 200 且无 Set-Cookie，例如 dsh-tauri 等回环直连
//       免鉴权的载体）则标记为 open 并按免 cookie 继续，不再致命抛错。请求走 POST /api/<ns/method> {args}；
//       流走单一 WS /api/remote.mux（open/item/end/error/cancel 复用）；
//       审批/提问走 $events 瀑布 + $events/result（不再有 events.mux / events.host / respond）。
//   协议在首次调用时自动探测（v2 探针 401=需要鉴权，探针要求 ok:true 防误判）；探测失败即 fail-fast 并提示升级 DSH。
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export class DshClient {
  constructor(baseUrl, { stateDir, token } = {}) {
    this.baseUrl = baseUrl.replace(/\/$/, "");
    this.token = token ?? "";
    this.stateDir = stateDir ?? null;
    this.cookie = this.#loadCookie(); // { name, value, expiresAt }
    // 鉴权形态（1.0.7 起，由 401/交换结果决定，不再"有 token 就强制铸"）：
    //   cookie = 需要浏览器会话（官方 DSH：401 才触发铸 cookie，铸成功即此态）；
    //   open   = 本 DSH 不做 token→cookie 交换、回环直连免鉴权（如 dsh-tauri）→ 永久免 cookie；
    //   unknown= 尚未判定（先按免 cookie 试，401/交换失败后再定）。
    this.authMode = this.cookie ? "cookie" : "unknown";
    this.openDiagLogged = false; // open 判定只打一次日志
    this.mux = null;
    this.protocol = null; // 固定 "v2"（旧版 DSH 支持已移除）
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
    // 只支持 v2（新 DSH）。失败通常是：DSH 没在跑，或装的是已不再支持的旧版 DSH（≤0.1.5-rc.6）。
    throw new Error(
      "v2 协议握手失败：请确认 DSH 正在运行（dsh web）；本插件版本已不再支持旧版 DSH（≤0.1.5-rc.6），如为旧版请先升级 DSH",
    );
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


  setToken(token) {
    if (token && token !== this.token) {
      this.token = token;
      this.cookie = null;
      // 新 token 重新判定鉴权形态（官方 DSH 的旧 token 会 401，新 token 往往就能铸成功）
      this.authMode = "unknown";
      this.openDiagLogged = false;
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

  /** 用 launch token 换会话 Cookie：GET /?token=…（redirect: manual）→ 303 + Set-Cookie。
   *  1.0.7 起**换不到不再一律致命**，按响应分类：
   *   - HTTP 200 且无 dsh-auth-* Set-Cookie ⇒ 该 DSH 的根路径不提供交换（回环直连免鉴权，
   *     如 dsh-tauri）⇒ 标记 open、记一次日志、返回 null（调用方按免 cookie 继续）；
   *   - 其余（401 / 网络错误 = token 失效或 DSH 未就绪）⇒ 保持抛错，调用方按"未连接"退避重试，
   *     下次再试（官方 DSH 换到有效 token 后即恢复铸证）。
   *  官方 DSH（需要 401→铸证的那类）路径**原样保留**：401 → 本函数 → 303+Set-Cookie → 正常带证。 */
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
      if (res.status === 200) {
        // 该 DSH 不做 token→cookie 交换：免 cookie 直连（dsh-tauri 类载体）
        this.authMode = "open";
        if (!this.openDiagLogged) {
          this.openDiagLogged = true;
          console.log("[dsh] token exchange unavailable (HTTP 200, no dsh-auth cookie); proceeding without cookie");
        }
        return null;
      }
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
    this.authMode = "cookie";
    this.#saveCookie(c);
    return c;
  }

  /** 当前应携带的 Cookie 头；返回 null = 免 cookie 直连（老版 DSH / open 形态 / 无 token）。
   *  未知形态且有 token 时会尝试铸一次（官方 DSH 由此拿到证；失败抛错由调用方退避）。 */
  async cookieHeader() {
    if (this.cookie) return `${this.cookie.name}=${this.cookie.value}`;
    if (!this.token || this.authMode === "open") return null;
    const c = await this.#mintCookie();
    return c ? `${c.name}=${c.value}` : null;
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

  /** unary：首次调用自动完成 v2 协议探测；载荷为 {args}。 */
  async unary(endpoint, args = {}, opts = {}) {
    await this.ensureProtocol();
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
