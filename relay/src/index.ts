import http from "node:http";
import { WebSocketServer } from "ws";
import { initDb } from "./db/connection.js";
import { runMigrations } from "./db/migrate.js";
import { logger } from "./lib/logger.js";
import { createApp } from "./app.js";
import { config } from "./config.js";
import {
  handleBridgeConnection,
  handleClientConnection,
  relayManager,
} from "./ws/relay.js";
import * as transferService from "./services/transfer-service.js";

const db = initDb();
runMigrations(db);
logger.info("Database initialized and migrations applied");

// 桥上线 → 重投该设备 ready 状态的传输（Data plane）
relayManager.onBridgeOnline = (deviceId) => {
  transferService.redeliverForDevice(deviceId);
};

const app = createApp(db);

const server = http.createServer(app);

// WebSocket relay
const wss = new WebSocketServer({ noServer: true });

server.on("upgrade", (req, socket, head) => {
  const url = req.url ?? "";
  const pathname = url.split("?")[0];

  if (pathname === "/ws/bridge" || pathname === "/ws/client") {
    wss.handleUpgrade(req, socket, head, (ws) => {
      // 纵深防御（审计 P0）：连接建立阶段的任何意外异常都只关闭该连接，
      // 绝不允许抛出到 upgrade 事件之外导致进程崩溃（DoS）。
      try {
        if (pathname === "/ws/bridge") {
          handleBridgeConnection(ws, req);
        } else {
          handleClientConnection(ws, req);
        }
      } catch (err) {
        logger.error(
          { path: pathname, error: (err as Error)?.message ?? String(err) },
          "connection setup threw - closing socket"
        );
        try {
          ws.close(1011, "internal error");
        } catch {}
      }
    });
    return;
  }

  socket.destroy();
});

if (process.env.NODE_ENV !== "test") {
  server.listen(config.port, () => {
    logger.info(
      { port: config.port },
      `Relay server (HTTP + WS) listening on port ${config.port}`
    );
  });
}

export { app, server };
