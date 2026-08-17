// DSH 本地 API 客户端：unary POST + 两条只读下行 WS（mux/host）。
// 只做无副作用调用与流订阅；所有写操作在 adapter 里过锁后才调用 unary。
import { randomUUID } from "node:crypto";

export class DshClient {
  constructor(baseUrl) {
    this.baseUrl = baseUrl.replace(/\/$/, "");
  }

  /** unary：POST /api/<method>，返回 {ok, value|error} */
  async unary(method, payload, { timeoutMs = 30000 } = {}) {
    const rpcId = randomUUID();
    const res = await fetch(`${this.baseUrl}/api/${method}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ type: "client-request", rpcId, method, payload }),
      signal: AbortSignal.timeout(timeoutMs),
    });
    const body = await res.json();
    if (body?.type !== "server-response" || body.rpcId !== rpcId) {
      return { ok: false, error: { code: "protocol-error", message: `unexpected response for ${method}: ${res.status}` } };
    }
    return body.result;
  }

  /** 应答审批/提问：POST /api/respond。cancel=true 时发 ok:false + cancelled（DSH 的跳过语义）。
   *  DSH 的 HTTP 层总是 200，真正的接受/拒绝在响应体的 accepted/reason 里，必须透出。 */
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

  /** 打开一条下行 WS 流；onFrame 收到 {rpcId, method, payload}；onState 收到 open/close/error。 */
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
}
