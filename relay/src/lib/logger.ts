import pino from "pino";
import { config } from "../config.js";

export const logger = pino({
  level: config.logLevel,
  transport:
    config.nodeEnv === "development"
      ? { target: "pino-pretty", options: { colorize: true } }
      : undefined,
  redact: {
    paths: [
      "password",
      "password_hash",
      "refreshToken",
      "refresh_token_hash",
      "accessToken",
      "body.password",
      "body.refreshToken",
      "body.plaintextCode",
      "req.headers.authorization",
      "req.headers.sec-websocket-protocol",
    ],
    censor: "[REDACTED]",
  },
});
