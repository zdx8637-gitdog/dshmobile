// relay /ws/bridge 客户端：设备注册 + 认证连接 + 心跳 + 信封收发。
import { randomUUID } from "node:crypto";

export class RelayBridge {
  constructor({ url, username, password, deviceLabel, platform, clientDeviceKey, stateDir }) {
    this.url = url.replace(/\/$/, "");
    this.username = username;
    this.password = password;
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
      throw new Error(`${path} failed: HTTP ${res.status} ${JSON.stringify(body?.error ?? body)}`);
    }
    return body;
  }

  /** 登录拿 access token，然后注册/复用设备拿 device token。 */
  async provision() {
    const login = await this.#restJson("/auth/login", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ username: this.username, password: this.password }),
    });
    const accessToken = login.data.accessToken;

    // 同一 clientDeviceKey 重复注册会返回同一个 deviceId + 新 token（幂等）
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
      this.ws.send(JSON.stringify(envelope));
      return true;
    }
    return false;
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
