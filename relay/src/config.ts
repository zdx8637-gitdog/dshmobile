import crypto from "node:crypto";
import dotenv from "dotenv";
dotenv.config();

function resolveJwtSecret(): string {
  if (process.env.JWT_SECRET) return process.env.JWT_SECRET;
  if (process.env.NODE_ENV === "production") {
    throw new Error("Missing required env var: JWT_SECRET");
  }
  const randomSecret = crypto.randomBytes(32).toString("hex");
  console.warn(
    `[WARNING] JWT_SECRET not set — using randomly generated key for dev only: ${randomSecret}`
  );
  return randomSecret;
}

function resolveDevToken(): string {
  if (process.env.RELAY_DEV_TOKEN) return process.env.RELAY_DEV_TOKEN;
  if (process.env.NODE_ENV === "production") {
    throw new Error("Missing required env var: RELAY_DEV_TOKEN");
  }
  const randomToken = crypto.randomBytes(16).toString("hex");
  console.warn(
    `[WARNING] RELAY_DEV_TOKEN not set — using randomly generated token for dev only: ${randomToken}`
  );
  return randomToken;
}

function resolveAllowDevToken(): boolean {
  if (process.env.RELAY_ALLOW_DEV_TOKEN === "1") return true;
  if (process.env.NODE_ENV === "test") return true;
  return false;
}

export const config = {
  port: parseInt(process.env.PORT ?? "48730", 10),
  jwtSecret: resolveJwtSecret(),
  relayDevToken: resolveDevToken(),
  allowDevToken: resolveAllowDevToken(),
  accessTokenTTL: parseInt(process.env.ACCESS_TOKEN_TTL ?? "900", 10),
  deviceTokenTTL: parseInt(process.env.DEVICE_TOKEN_TTL ?? "86400", 10),
  refreshTokenTTL: parseInt(process.env.REFRESH_TOKEN_TTL ?? "2592000", 10),
  bcryptRounds: parseInt(process.env.BCRYPT_ROUNDS ?? "12", 10),
  pairingCodeTTL: parseInt(process.env.PAIRING_CODE_TTL ?? "300", 10),
  pairingCodeLength: parseInt(process.env.PAIRING_CODE_LENGTH ?? "6", 10),
  rateLimitAuthWindowMs: parseInt(process.env.RATE_LIMIT_AUTH_WINDOW_MS ?? "60000", 10),
  rateLimitAuthMax: parseInt(process.env.RATE_LIMIT_AUTH_MAX ?? "10", 10),
  rateLimitPairingWindowMs: parseInt(process.env.RATE_LIMIT_PAIRING_WINDOW_MS ?? "60000", 10),
  rateLimitPairingMax: parseInt(process.env.RATE_LIMIT_PAIRING_MAX ?? "5", 10),
  dbPath: process.env.DB_PATH ?? "data/relay.db",
  logLevel: process.env.LOG_LEVEL ?? "info",
  nodeEnv: process.env.NODE_ENV ?? "development",
} as const;
