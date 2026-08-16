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
} from "./ws/relay.js";

const db = initDb();
runMigrations(db);
logger.info("Database initialized and migrations applied");

const app = createApp(db);

const server = http.createServer(app);

// WebSocket relay
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

if (process.env.NODE_ENV !== "test") {
  server.listen(config.port, () => {
    logger.info(
      { port: config.port },
      `Relay server (HTTP + WS) listening on port ${config.port}`
    );
  });
}

export { app, server };
