import crypto from "node:crypto";
import { config } from "../config.js";
import { signAccessToken } from "../lib/jwt.js";
import { hashSecret, verifySecret } from "../lib/hash.js";
import * as userModel from "../models/user.js";
import * as sessionModel from "../models/auth-session.js";
import * as auditLog from "../models/audit-log.js";
import { AuthError, ConflictError } from "../lib/errors.js";

function generateRefreshToken(): {
  token: string;
  selector: string;
  secretHash: string;
} {
  const selector = crypto.randomBytes(32).toString("base64url");
  const secret = crypto.randomBytes(32).toString("base64url");
  return { token: selector + "." + secret, selector, secretHash: "" };
}

// Legacy token format (no selector/secret split, for backward compat)
function generateLegacyRefreshToken(): string {
  return crypto.randomBytes(48).toString("base64url");
}

export async function register(
  username: string,
  password: string,
  displayName?: string
): Promise<{ userId: string; username: string }> {
  const existing = userModel.findByUsername(username);
  if (existing) {
    throw new ConflictError("Username already exists");
  }

  const passwordHash = await hashSecret(password);
  const user = userModel.createUser({
    username,
    passwordHash,
    displayName: displayName ?? null,
  });

  auditLog.insertLog({
    userId: user.id,
    action: "register",
    targetType: "user",
    targetId: user.id,
  });

  return { userId: user.id, username: user.username ?? username };
}

export async function login(
  usernameOrEmail: string,
  password: string,
  ip?: string
): Promise<{ accessToken: string; refreshToken: string; userId: string; username: string }> {
  let user = userModel.findByUsername(usernameOrEmail);
  if (!user) {
    user = userModel.findByEmail(usernameOrEmail);
  }
  if (!user) {
    throw new AuthError("Invalid username or password", false);
  }

  if (user.disabled_at) {
    throw new AuthError("Account disabled", false);
  }

  const valid = await verifySecret(password, user.password_hash);
  if (!valid) {
    throw new AuthError("Invalid username or password", false);
  }

  const accessToken = signAccessToken(user.id);
  const { token: refreshToken, selector, secretHash } = generateRefreshToken();
  const refreshHash = await hashSecret(refreshToken);
  const finalSecretHash = await hashSecret(refreshToken.slice(refreshToken.indexOf(".") + 1));

  sessionModel.createSession({
    userId: user.id,
    refreshTokenHash: refreshHash,
    ttlSeconds: config.refreshTokenTTL,
    tokenSelector: selector,
    tokenSecretHash: finalSecretHash,
  });

  auditLog.insertLog({
    userId: user.id,
    action: "login",
    targetType: "user",
    targetId: user.id,
    ipHash: ip ? await hashSecret(ip) : null,
  });

  return { accessToken, refreshToken, userId: user.id, username: user.username ?? "" };
}

export async function refresh(oldRefreshToken: string): Promise<{
  accessToken: string;
  refreshToken: string;
  userId: string;
}> {
  const session = await findSessionByRefreshToken(oldRefreshToken);
  if (!session) {
    throw new AuthError("Invalid refresh token", false);
  }

  if (session.revoked_at) {
    throw new AuthError("Session revoked", false);
  }

  if (new Date(session.expires_at) < new Date()) {
    throw new AuthError("Session expired", true);
  }

  // Rotate: revoke old, issue new
  sessionModel.revokeSession(session.id);

  const accessToken = signAccessToken(session.user_id);
  const { token: newRefreshToken, selector, secretHash } = generateRefreshToken();
  const newRefreshHash = await hashSecret(newRefreshToken);
  const finalSecretHash = await hashSecret(newRefreshToken.slice(newRefreshToken.indexOf(".") + 1));

  sessionModel.createSession({
    userId: session.user_id,
    refreshTokenHash: newRefreshHash,
    ttlSeconds: config.refreshTokenTTL,
    tokenSelector: selector,
    tokenSecretHash: finalSecretHash,
  });

  return { accessToken, refreshToken: newRefreshToken, userId: session.user_id };
}

export async function logout(refreshToken: string): Promise<void> {
  const session = await findSessionByRefreshToken(refreshToken);
  if (session) {
    sessionModel.revokeSession(session.id);
  }
}

/** 为指定用户直接签发一对会话 token（扫码配对核销用；不动用户密码）。 */
export async function issueSession(
  userId: string
): Promise<{ accessToken: string; refreshToken: string }> {
  const accessToken = signAccessToken(userId);
  const { token: refreshToken, selector } = generateRefreshToken();
  const refreshHash = await hashSecret(refreshToken);
  const finalSecretHash = await hashSecret(
    refreshToken.slice(refreshToken.indexOf(".") + 1)
  );

  sessionModel.createSession({
    userId,
    refreshTokenHash: refreshHash,
    ttlSeconds: config.refreshTokenTTL,
    tokenSelector: selector,
    tokenSecretHash: finalSecretHash,
  });

  return { accessToken, refreshToken };
}

async function findSessionByRefreshToken(token: string): Promise<any | null> {
  const db = (await import("../db/connection.js")).getDb();

  // Path 1: selector.secret format (new tokens)
  const dotIndex = token.indexOf(".");
  if (dotIndex > 0) {
    const selector = token.slice(0, dotIndex);
    const secret = token.slice(dotIndex + 1);
    // selector is 32 random bytes base64url-encoded = 43 chars
    if (selector.length === 43) {
      const session = sessionModel.findByTokenSelector(selector);
      if (session?.token_secret_hash && await verifySecret(secret, session.token_secret_hash)) {
        return session;
      }
      return null; // selector matched but secret mismatch
    }
  }

  // Path 2: legacy linear bcrypt scan (old tokens without selector)
  const sessions = db
    .prepare("SELECT * FROM auth_sessions WHERE revoked_at IS NULL AND token_selector IS NULL")
    .all() as any[];

  for (const session of sessions) {
    const match = await verifySecret(token, session.refresh_token_hash);
    if (match) return session;
  }

  return null;
}
