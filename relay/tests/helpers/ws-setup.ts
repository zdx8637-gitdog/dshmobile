import http from "node:http";
import { WebSocketServer, WebSocket } from "ws";
import Database from "better-sqlite3";
import { runMigrations } from "../../src/db/migrate.js";
import { setTestDb } from "../../src/db/connection.js";
import { createApp } from "../../src/app.js";
import {
  handleBridgeConnection,
  handleClientConnection,
} from "../../src/ws/relay.js";

// Register migrations
import "../../src/db/migrations/001_create_users.js";
import "../../src/db/migrations/002_create_auth_sessions.js";
import "../../src/db/migrations/003_create_devices.js";
import "../../src/db/migrations/004_create_pairing_codes.js";
import "../../src/db/migrations/005_create_audit_logs.js";
import "../../src/db/migrations/006_add_username_device_tokens.js";

export interface WsTestContext {
  db: Database.Database;
  app: ReturnType<typeof createApp>;
  server: http.Server;
  port: number;
  baseUrl: string;
  wsBaseUrl: string;
  close: () => Promise<void>;
}

export function createWsTestApp(): Promise<WsTestContext> {
  return new Promise((resolve, reject) => {
    const db = new Database(":memory:");
    db.pragma("journal_mode = WAL");
    db.pragma("foreign_keys = ON");
    runMigrations(db);
    setTestDb(db);

    const app = createApp(db);
    const server = http.createServer(app);

    const wss = new WebSocketServer({ noServer: true });

    server.on("upgrade", (req, socket, head) => {
      const url = req.url ?? "";
      const pathname = url.split("?")[0];

      if (pathname === "/ws/bridge" || pathname === "/ws/client") {
        wss.handleUpgrade(req, socket, head, (ws) => {
          if (pathname === "/ws/bridge") {
            handleBridgeConnection(ws, req);
          } else {
            handleClientConnection(ws, req);
          }
        });
        return;
      }

      socket.destroy();
    });

    server.listen(0, () => {
      const addr = server.address();
      if (!addr || typeof addr === "string") {
        reject(new Error("Could not get server address"));
        return;
      }
      const port = addr.port;
      resolve({
        db,
        app,
        server,
        port,
        baseUrl: `http://127.0.0.1:${port}`,
        wsBaseUrl: `ws://127.0.0.1:${port}`,
        close: () =>
          new Promise<void>((res) => {
            server.close(() => res());
          }),
      });
    });

    server.on("error", reject);
  });
}

// Wraps a WebSocket with exactly-once message consumption
export interface BufferedWs {
  ws: WebSocket;
  messages: unknown[];
  waitForMessage: (timeoutMs?: number) => Promise<unknown>;
  drainMessages: () => unknown[];
  waitForClose: (timeoutMs?: number) => Promise<number>;
}

export function connectWs(
  ctx: WsTestContext,
  path: string
): Promise<BufferedWs> {
  return new Promise((resolve, reject) => {
    // Queue of pending consumers (FIFO)
    const pending: Array<{
      resolve: (m: unknown) => void;
      reject: (e: Error) => void;
    }> = [];
    // Buffer for unconsumed messages (arrived before anyone waited)
    const buffer: unknown[] = [];

    let closeCode: number | null = null;
    let closeResolve: ((code: number) => void) | null = null;

    const ws = new WebSocket(`${ctx.wsBaseUrl}${path}`);

    ws.on("message", (raw) => {
      const parsed = JSON.parse(raw.toString());
      if (pending.length > 0) {
        const next = pending.shift()!;
        next.resolve(parsed);
      } else {
        buffer.push(parsed);
      }
    });

    ws.on("close", (code) => {
      closeCode = code;
      if (closeResolve) closeResolve(code);
      // Reject all pending consumers
      for (const p of pending) {
        p.reject(new Error("connection closed"));
      }
      pending.length = 0;
    });

    ws.on("open", () => {
      resolve({
        ws,
        messages: buffer,
        waitForMessage: (timeoutMs: number = 3000) => {
          // Return buffered message first
          if (buffer.length > 0) {
            return Promise.resolve(buffer.shift()!);
          }
          return new Promise((res, rej) => {
            const timer = setTimeout(() => {
              // Remove from pending queue on timeout
              const idx = pending.findIndex(
                (p) => p.resolve === res && p.reject === rej
              );
              if (idx !== -1) pending.splice(idx, 1);
              rej(new Error("timeout waiting for message"));
            }, timeoutMs);
            pending.push({
              resolve: (m) => {
                clearTimeout(timer);
                res(m);
              },
              reject: (e) => {
                clearTimeout(timer);
                rej(e);
              },
            });
          });
        },
        drainMessages: () => {
          const drained = [...buffer];
          buffer.length = 0;
          return drained;
        },
        waitForClose: (timeoutMs: number = 5000) => {
          return new Promise((res, rej) => {
            if (closeCode !== null) {
              res(closeCode);
              return;
            }
            const timer = setTimeout(
              () => rej(new Error("timeout waiting for close")),
              timeoutMs
            );
            closeResolve = (code: number) => {
              clearTimeout(timer);
              res(code);
            };
          });
        },
      });
    });

    ws.on("error", (err) => {
      if (
        ws.readyState === WebSocket.CLOSED ||
        ws.readyState === WebSocket.CLOSING
      )
        return;
      reject(err);
    });

    setTimeout(() => reject(new Error("ws connect timeout")), 5000);
  });
}
