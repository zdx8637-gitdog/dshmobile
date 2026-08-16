/**
 * Helper for creating WebSocket connections with Authorization: Bearer headers
 * and buffered message consumption. Works with vitest's NODE_ENV=test.
 */
import { WebSocket } from "ws";
import type { WsTestContext } from "./ws-setup.js";

export interface AuthWs {
  ws: WebSocket;
  nextMessage: (timeoutMs?: number) => Promise<Record<string, unknown>>;
  drainMessages: () => Record<string, unknown>[];
  waitForClose: (timeoutMs?: number) => Promise<number>;
}

function wrapAuthSocket(
  ws: WebSocket,
  resolve: (value: AuthWs) => void,
  reject: (reason: Error) => void,
): void {
  const buffer: Record<string, unknown>[] = [];
  const pending: Array<{
    resolve: (m: Record<string, unknown>) => void;
    reject: (e: Error) => void;
  }> = [];
  let closeCode: number | null = null;
  let closeResolver: ((c: number) => void) | null = null;

  ws.on("message", (raw) => {
    const parsed = JSON.parse(raw.toString());
    if (pending.length > 0) {
      pending.shift()!.resolve(parsed);
    } else {
      buffer.push(parsed);
    }
  });

  ws.on("close", (code) => {
    closeCode = code;
    if (closeResolver) closeResolver(code);
    for (const p of pending) p.reject(new Error("connection closed"));
    pending.length = 0;
  });

  ws.on("open", () => {
    resolve({
      ws,
      nextMessage: (timeoutMs = 3000) => {
        if (buffer.length > 0) return Promise.resolve(buffer.shift()!);
        return new Promise((res, rej) => {
          const timer = setTimeout(() => {
            const idx = pending.findIndex((p) => p.resolve === res);
            if (idx !== -1) pending.splice(idx, 1);
            rej(new Error("timeout waiting for message"));
          }, timeoutMs);
          pending.push({
            resolve: (m) => { clearTimeout(timer); res(m); },
            reject: (e) => { clearTimeout(timer); rej(e); },
          });
        });
      },
      drainMessages: () => {
        const d = [...buffer];
        buffer.length = 0;
        return d;
      },
      waitForClose: (timeoutMs = 5000) => {
        if (closeCode !== null) return Promise.resolve(closeCode);
        return new Promise((res, rej) => {
          const timer = setTimeout(() => rej(new Error("timeout waiting for close")), timeoutMs);
          closeResolver = (c) => { clearTimeout(timer); res(c); };
        });
      },
    });
  });

  ws.on("error", (err) => {
    if (ws.readyState === WebSocket.CLOSED || ws.readyState === WebSocket.CLOSING) return;
    reject(err);
  });

  setTimeout(() => reject(new Error("ws connect timeout")), 5000);
}

export function connectAuthWs(
  ctx: WsTestContext,
  path: string,
  token: string,
): Promise<AuthWs> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`${ctx.wsBaseUrl}${path}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    wrapAuthSocket(ws, resolve, reject);
  });
}

export function connectProtocolWs(
  ctx: WsTestContext,
  path: string,
  token: string,
): Promise<AuthWs> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`${ctx.wsBaseUrl}${path}`, ["bearer", token]);
    wrapAuthSocket(ws, resolve, reject);
  });
}
