// relay /ws/bridge 客户端：设备注册 + 认证连接 + 心跳 + 信封收发。
import { randomUUID } from "node:crypto";

/** E2EE 下仍需明文（relay 亲自处理/握手）的消息类型。 */
// transfer.deliver：relay→桥 控制面指令（relay 非 E2EE 端点，只能明文投递；桥的响应也必须明文回去）。
// 加解密双向豁免；adapter 侧另校验 actor.role==="relay"（手机从不发此类型）。
// e2ee.state / e2ee.allowPlaintext：E2EE 策略的控制面——手机必须在**明文**下就能问「本机是否要求加密」
// 并明确选择降级（否则被拒后连"怎么自救"都问不出来，人在外地也点不到电脑面板）。这两个类型永远放行。
const PLAINTEXT_TYPES = new Set(["heartbeat.ping", "heartbeat.pong", "e2ee.hello", "key.exchange", "device.register", "e2ee.clear", "transfer.deliver", "e2ee.state", "e2ee.allowPlaintext"]);

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
    this.onDuplicateKick = null; // () => void：本连接被 relay 按 "duplicate connection"(4000) 顶替时回调
    this.e2ee = e2ee; // 可选 E2eeSession：加解密透传（未建立则原样）
    // 明文业务请求是否放行（由 Adapter 构造时自注册；relay 不 import adapter，避免循环依赖）。
    // 未注册 → 恒定放行：保持"没有 adapter 的裸 RelayBridge / 既有测试"的原语义。
    this.plaintextGuard = null;
  }

  /**
   * 注入明文强制拒绝的判定：fn(env) === false → 回 E2EE_REQUIRED（判定为 true/未注入 → 放行）。
   * 传非函数即清除（等价于关闭强制）。
   */
  setPlaintextGuard(fn) {
    this.plaintextGuard = typeof fn === "function" ? fn : null;
  }

  /**
   * 明文业务请求是否放行。未注入判定或判定抛错都按**放行**处理（fail-open）：
   * 内部的判定错误绝不能让用户既连不上、又看不到任何提示。
   */
  isPlaintextAllowed(env) {
    if (typeof this.plaintextGuard !== "function") return true;
    try {
      return this.plaintextGuard(env) !== false;
    } catch (err) {
      console.warn("[relay] plaintextGuard failed, allowing plaintext:", err?.message ?? err);
      return true;
    }
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
      // 4000 = relay 侧的 "duplicate connection"：本机有另一个桥实例用同一设备标识连了上来，
      // relay 只保留最新一条，于是把本连接踢掉。反复出现即为"双桥互踢"，见 WORKFLOW.md §7.0。
      if (this.lastCloseCode === 4000) {
        console.warn("[relay] 本桥被另一个桥实例顶替（relay close 4000 = duplicate connection）");
        try { this.onDuplicateKick?.(); } catch { /* 自愈失败不影响重连 */ }
      }
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
    if (PLAINTEXT_TYPES.has(env.type)) return env;
    if (!this.e2ee) return env; // 未启用 E2EE：全部按明文透传（不误报 RESTARTED）
    const established = this.e2ee.isConnectionEstablished === true;
    if (!established) {
      // 桥刚重启：本端每连接密钥已随进程丢失。收到加密信封 → 回 E2EE_RESTARTED，
      // 让手机丢弃旧连接密钥并重新 e2ee.hello。
      if (env.kind === "request" && typeof env.requestId === "string" && (env.crypto || env.payload?.ct)) {
        this.#rejectEnvelope(env, "E2EE_RESTARTED", "bridge restarted; E2EE connection keys were reset, please re-handshake");
        return null;
      }
      // 明文业务请求（PLAINTEXT_TYPES 已在上方提前放行）：
      // 默认策略（e2ee-policy.json require=true）下必须走 E2EE —— 只有同时满足
      //   ① 策略要求加密；② 该客户端被确认支持新协议（appVersion ≥ 0.2.21，未知版本 fail-open）；
      //   ③ 该 clientId 本次进程内没有临时明文放行（e2ee.allowPlaintext mode=session）
      // 才拒绝（判定在 adapter.isPlaintextAllowed，条件 ③ 亦来自它）。
      // 目的：PC 已配对时不再静默放行"没有本地 pin 的手机（重装 App 后）"，让 App 能明确提示
      // 重新配对或降级；同时老 App（不上报版本）一律放行、控制类永远放行，不会被卡死。
      if (env.kind === "request" && typeof env.requestId === "string" && !this.isPlaintextAllowed(env)) {
        this.#rejectEnvelope(
          env,
          "E2EE_REQUIRED",
          "该设备已启用端到端加密，请重新扫码配对 E2EE，或确认回退到非加密模式",
          this.#e2eeRequiredData(),
        );
        return null;
      }
      return env;
    }
    if (!env.crypto || !env.payload?.ct) {
      // 已配对却收到明文（手机重装后新身份未配对）→ 回 E2EE_REQUIRED，让手机提示重新配对/确认回退。
      //
      // ⚠ 2026-09-24 修：「临时明文」这条自救路径在这条分支上**永远走不通**。
      //   第一段（!established）会先问 `isPlaintextAllowed()`，放行就过；
      //   但这一段的判据只有"本端密钥是否建立"，**完全没看用户是否已经明确选择降级** ——
      //   于是"桥侧已配对（isConnectionEstablished=true）+ 手机侧没 pin（重装后发的是明文）"这个组合下，
      //   用户在手机上点多少次「本次先用明文」都会被这里原样拒掉，且桥根本收不到请求
      //   （用户看到的就是"临时明文没用 / 刷不出会话"）。
      //   `isConnectionEstablished` 只说明**桥端**有连接密钥，推不出"手机端也有" ——
      //   pin 丢失的手机正是拿不到密钥、只能发明文的那一类。
      //   放行口径与第一段保持一致：控制类照旧提前放行，这里补上"用户显式降级"这一条。
      if (env.kind === "request" && typeof env.requestId === "string" && !this.isPlaintextAllowed(env)) {
        this.#rejectEnvelope(
          env,
          "E2EE_REQUIRED",
          "该设备已启用端到端加密，请重新扫码配对 E2EE，或确认回退到非加密模式",
          this.#e2eeRequiredData(),
        );
      }
      return null;
    }
    try {
      const { type, requestId, targetDeviceId } = envelopeAadContext(env);
      const payload = this.e2ee.decryptIncoming({ type, requestId, targetDeviceId, crypto: env.crypto, meta: env.meta ?? {}, payload: env.payload });
      return { ...env, payload };
    } catch (err) {
      // 密钥不匹配/序号错乱：对端持有的连接密钥已失效 → 同样回 E2EE_RESTARTED 触发重握手
      if (env.kind === "request" && typeof env.requestId === "string") {
        this.#rejectEnvelope(env, "E2EE_RESTARTED", `E2EE connection keys are unusable (${err?.message ?? err}); please re-handshake`);
      }
      return null;
    }
  }

  /** E2EE_REQUIRED 的补充状态（只增字段）：手机据此显示「PC 要求加密 / 是否已配对」并决定自救路径。 */
  #e2eeRequiredData() {
    const pin = this.e2ee?.pinState ?? {};
    return {
      reason: "require-e2ee",
      require: true,
      pinned: pin.pinned === true,
      bridgeKeyId: typeof pin.bridgeKeyId === "string" ? pin.bridgeKeyId : "",
    };
  }

  /** 对一条请求回显式错误响应（E2EE_RESTARTED / E2EE_REQUIRED）。
   *  control 标记：桥在密钥失效时只能用明文发控制错误，客户端据此与"降级攻击"区分。
   *  data 可选：附加状态（只增字段，老客户端忽略）。 */
  #rejectEnvelope(env, code, message, data) {
    const plain = JSON.stringify({
      schemaVersion: 1,
      envelopeId: randomUUID(),
      kind: "response",
      type: env.type,
      sentAt: new Date().toISOString(),
      actor: { role: "bridge", deviceId: this.deviceId },
      requestId: env.requestId,
      payload: { ok: false, error: { code, message, ...(data ? { data } : {}) }, control: true },
    });
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(plain);
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
