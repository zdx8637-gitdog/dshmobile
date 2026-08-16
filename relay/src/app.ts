import express from "express";
import path from "node:path";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";
import { config } from "./config.js";
import { RateLimiter } from "./lib/rate-limiter.js";
import { requestLogger } from "./middleware/request-logger.js";
import { rateLimit } from "./middleware/rate-limit.js";
import { errorHandler } from "./middleware/error-handler.js";

// Import migrations to register them
import "./db/migrations/001_create_users.js";
import "./db/migrations/002_create_auth_sessions.js";
import "./db/migrations/003_create_devices.js";
import "./db/migrations/004_create_pairing_codes.js";
import "./db/migrations/005_create_audit_logs.js";
import "./db/migrations/006_add_username_device_tokens.js";
import "./db/migrations/007_device_dedup.js";
import './db/migrations/008_indexed_refresh_tokens.js';
import "./db/migrations/009_pairing_grant.js";

import healthRoutes from "./routes/health.js";
import authRoutes from "./routes/auth.js";
import meRoutes from "./routes/me.js";
import devicesRoutes from "./routes/devices.js";
import pairingCodesRoutes from "./routes/pairing-codes.js";
// 公开核销入口：必须先于其它带 authenticate 的路由器挂载
import pairingVerifyRoutes from "./routes/pairing-verify.js";

export function createApp(_db: Database.Database) {
  const authLimiter = new RateLimiter(
    config.rateLimitAuthWindowMs,
    config.rateLimitAuthMax
  );
  const pairingLimiter = new RateLimiter(
    config.rateLimitPairingWindowMs,
    config.rateLimitPairingMax
  );
  // 出码/授权/轮询面（非爆破目标）：额度放宽，插件常驻二维码会频繁出码
  const pairingFlowLimiter = new RateLimiter(
    config.rateLimitPairingWindowMs,
    config.rateLimitPairingMax * 6
  );

  const app = express();

  // Static files for remote-web client
  const publicDir = process.env.PUBLIC_DIR
    || path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../public");
  app.use(express.static(publicDir));

  app.use(requestLogger);
  app.use(express.json());

  app.use("/auth/login", rateLimit(authLimiter));
  app.use("/auth/refresh", rateLimit(authLimiter));
  // 无登录态的核销入口单独严限流（防爆破 6 位码），必须先挂
  app.use("/pairing-codes/verify", rateLimit(pairingLimiter));
  app.use("/pairing-codes", rateLimit(pairingFlowLimiter));

  app.use(pairingVerifyRoutes); // 公开：必须最先挂
  app.use(healthRoutes);
  app.use(authRoutes);
  app.use(meRoutes);
  app.use(devicesRoutes);
  app.use(pairingCodesRoutes);

  app.use(errorHandler);

  return app;
}
