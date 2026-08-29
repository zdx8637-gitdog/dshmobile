// relay /ws/bridge 客户端：设备注册 + 认证连接 + 心跳 + 信封收发。
import { randomUUID } from "node:crypto";

/** E2EE 下仍需明文（relay 亲自处理/握手）的消息类型。 */
const PLAINTEXT_TYPES = new Set(["heartbeat.ping", "heartbeat.pong", "e2ee.hello", "key.exchange", "device.register"]);

/** 从信封提取 AAD 所需的稳定字段（两端一致：target 缺失回退 actor.deviceId；requestId 缺失回退 envelopeId）。 */
function envelopeAadContext(env) {
  return {
    type: typeof env.type === "string" ? env.type : "",
    requestId: typeof env.requestId === "string" ? env.requestId : (typeof env.envelopeId === "string" ? env.envelopeId : ""),
    targetDeviceId: (env.target?.deviceId ?? env.actor?.deviceId ?? ""),
  };
}

export class RelayBridge {
  constructor({ url, username, password, deviceLabel, platform, clientDeviceKey, stateDir, accessToken, refreshToken, e2ee = null }) {
    this.url = url.replace(/\/$/, "");
    this.username = username;
    this.password = password;
    // 插件授权模式：手机扫码授予的会话（无密码，token 直用）
    this.accessToken = accessToken;
    this.refreshToken = refreshToken;
    this.deviceLabel = deviceLabel;
    this.platform = platform;
    this.clientDeviceKey = clientDeviceKey;
    this.stateDir = stateDir;
    this.deviceId = null;
    this.deviceToken = null;
    this.ws = null;
    this.connected = false;
    this.lastCloseCode = null;
    this.lastCloseReason = null;
    this.onEnvelope = null; // (envelope) => void
    this.e2ee = e2ee; // 可选 E2eeSession：加解密透传（未建立则原样）
  }

  /** 关闭码是否表示"凭证失效"（设备被吊销/删除/令牌无效）→ 需要重新 provision 自愈。 */
  isAuthClose() {
    return (
      this.lastCloseCode === 4003 ||
      (this.lastCloseCode === 4001 &&
        !String(this.lastCloseReason ?? "").includes("heartbeat"))
    );
  }

  async #restJson(path, options = {}) {
    const res = await fetch(`${this.url}${path}`, options);
    const body = await res.json().catch(() => ({}));
    if (!res.ok || body?.ok === false) {
      const err = new Error(`${path} failed: HTTP ${res.status} ${JSON.stringify(body?.error ?? body)}`);
      err.status = res.status;
      throw err;
    }
    return body;
  }

  /** 拿一个可用的 access token：优先已有会话（token 直用，过期则刷新一次），否则账号密码登录。 */
  async #obtainAccessToken() {
    if (this.accessToken) {
      return this.accessToken;
    }
    const login = await this.#restJson("/auth/login", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ username: this.username, password: this.password }),
    });
    return login.data.accessToken;
  }

  /**
   * 用户 access token（反向传输/attachment.resolve 用）：
   * token 模式直用；密码模式登录一次并缓存（桥不轮换，宿主是会话唯一所有者）。
   */
  async userAccessToken() {
    if (this.accessToken) return this.accessToken;
    if (this._userToken) return this._userToken;
    const login = await this.#restJson("/auth/login", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ username: this.username, password: this.password }),
    });
    this._userToken = login.data.accessToken;
    return this._userToken;
  }

  /** 注册/复用设备（幂等，同 clientDeviceKey 返回同一 deviceId + 新 token）。 */
  async #registerDevice(accessToken) {
    const reg = await this.#restJson("/devices/register", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${accessToken}` },
      body: JSON.stringify({
        label: this.deviceLabel,
        platform: this.platform,
        clientDeviceKey: this.clientDeviceKey,
      }),
    });
    this.deviceId = reg.data.device.id;
    this.deviceToken = reg.data.deviceToken;
  }

  /**
   * 登录/授权拿 access token，然后注册/复用设备拿 device token。
   * 注意：桥**不轮换** refresh token——宿主是会话的唯一所有者，宿主刷新后会
   * 重写 config.json 并重启桥。桥自行 /auth/refresh 会轮换 token，把宿主的
   * 会话弄失效（双向轮换竞态 → 双方 401 死循环）。
   */
  async provision() {
    const accessToken = await this.#obtainAccessToken();
    await this.#registerDevice(accessToken);
    return { deviceId: this.deviceId };
  }

  connect() {
    if (!this.deviceToken) throw new Error("provision() first");
    // 浏览器 WS 无法带 Authorization header，这里通过 sec-websocket-protocol 承载：
    // relay 的 parseProtocolAuth 支持 ["bearer", "<token>"] 格式。
    const ws = new WebSocket(`${this.url.replace(/^https/, "wss")}/ws/bridge`, ["bearer", this.deviceToken]);
    this.ws = ws;
    this.openPromise = new Promise((resolve) => { ws.onopen = () => resolve(); });
    // 注意：closePromise 必须用 addEventListener 承载（onclose 赋值是替换语义，
    // 会覆盖这里并导致断开后 await 永不返回、重连循环卡死）。原生 WebSocket
    // 与 ws 包都支持 addEventListener 多监听器共存。
    this.closePromise = new Promise((resolve) => {
      ws.addEventListener("close", (ev) => {
        this.lastCloseCode = ev?.code ?? null;
        this.lastCloseReason = String(ev?.reason ?? "");
        resolve();
      });
    });

    ws.onopen = () => {
      this.connected = true;
      console.log("[relay] bridge connected, deviceId:", this.deviceId);
      // 注册确认（relay 直接应答）
      this.send({ schemaVersion: 1, kind: "request", type: "device.register", requestId: randomUUID(), sentAt: new Date().toISOString(), actor: { role: "bridge", deviceId: this.deviceId }, payload: {} });
    };
    ws.onmessage = (ev) => {
      try {
        const env = JSON.parse(ev.data);
        this.onEnvelope?.(env);
      } catch {
        /* 坏帧 */
      }
    };
    ws.onclose = () => {
      if (this.connected) console.log("[relay] bridge disconnected", this.lastCloseCode, this.lastCloseReason);
      this.connected = false;
    };
    ws.onerror = () => {};
    return ws;
  }

  send(envelope) {
    if (this.ws?.readyState === WebSocket.OPEN) {
      const out = this.encryptEnvelope(envelope);
      this.ws.send(JSON.stringify(out));
      return true;
    }
    return false;
  }

  /** E2EE 透传：未建立或明文类型 → 原样；否则加密 payload。 */
  encryptEnvelope(env) {
    if (!this.e2ee?.isConnectionEstablished) return env;
    if (PLAINTEXT_TYPES.has(env.type)) return env;
    const { type, requestId, targetDeviceId } = envelopeAadContext(env);
    const { crypto, payload } = this.e2ee.encryptOutgoing({ type, requestId, targetDeviceId, meta: {}, plaintextObj: env.payload ?? {} });
    return { ...env, crypto, payload };
  }

  /** E2EE 透传：未建立或明文类型 → 原样；否则解密 payload。 */
  decryptEnvelope(env) {
    if (!this.e2ee?.isConnectionEstablished) return env;
    if (PLAINTEXT_TYPES.has(env.type)) return env;
    const { type, requestId, targetDeviceId } = envelopeAadContext(env);
    const payload = this.e2ee.decryptIncoming({ type, requestId, targetDeviceId, crypto: env.crypto, meta: env.meta ?? {}, payload: env.payload });
    return { ...env, payload };
  }

  /** 对 relay 请求发 canonical response。 */
  respond(requestId, type, payload, extra = {}) {
    this.send({
      schemaVersion: 1,
      envelopeId: randomUUID(),
      kind: "response",
      type,
      sentAt: new Date().toISOString(),
      actor: { role: "bridge", deviceId: this.deviceId },
      requestId,
      payload,
      ...extra,
    });
  }

  /** 向 relay 推一个事件（fanout 到本设备的所有客户端）。 */
  forwardEvent(payload, type = "events.forward") {
    this.send({
      schemaVersion: 1,
      envelopeId: randomUUID(),
      kind: "event",
      type,
      sentAt: new Date().toISOString(),
      actor: { role: "bridge", deviceId: this.deviceId },
      target: { deviceId: this.deviceId },
      payload,
    });
  }

  startHeartbeat(intervalMs = 30000) {
    if (this._heartbeat) return;
    this._heartbeat = setInterval(() => {
      this.send({
        schemaVersion: 1,
        envelopeId: randomUUID(),
        kind: "heartbeat",
        type: "heartbeat.ping",
        sentAt: new Date().toISOString(),
        actor: { role: "bridge", deviceId: this.deviceId },
        payload: { now: new Date().toISOString() },
      });
    }, intervalMs);
  }
}
