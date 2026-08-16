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

  const app = express();

  // Static files for remote-web client
  const publicDir = process.env.PUBLIC_DIR
    || path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../public");
  app.use(express.static(publicDir));

  app.use(requestLogger);
  app.use(express.json());

  app.use("/auth/login", rateLimit(authLimiter));
  app.use("/auth/refresh", rateLimit(authLimiter));
  app.use("/pairing-codes", rateLimit(pairingLimiter));
  // 无登录态的核销入口单独限流（防爆破 6 位码）
  app.use("/pairing-codes/verify", rateLimit(pairingLimiter));

  app.use(pairingVerifyRoutes); // 公开：必须最先挂
  app.use(healthRoutes);
  app.use(authRoutes);
  app.use(meRoutes);
  app.use(devicesRoutes);
  app.use(pairingCodesRoutes);

  app.use(errorHandler);

  return app;
}
