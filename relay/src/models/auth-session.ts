import { getDb } from "../db/connection.js";
import { generateId } from "../lib/id-generator.js";
import type { AuthSession } from "../types/entities.js";

export function createSession(params: {
  userId: string;
  refreshTokenHash: string;
  ttlSeconds: number;
  tokenSelector?: string;
  tokenSecretHash?: string;
}): AuthSession {
  const db = getDb();
  const now = new Date().toISOString();
  const id = generateId();
  const expiresAt = new Date(Date.now() + params.ttlSeconds * 1000).toISOString();

  db.prepare(
    `INSERT INTO auth_sessions (id, user_id, refresh_token_hash, token_selector, token_secret_hash, created_at, expires_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  ).run(id, params.userId, params.refreshTokenHash,
    params.tokenSelector ?? null, params.tokenSecretHash ?? null, now, expiresAt);

  return {
    id,
    user_id: params.userId,
    refresh_token_hash: params.refreshTokenHash,
    token_selector: params.tokenSelector ?? null,
    token_secret_hash: params.tokenSecretHash ?? null,
    created_at: now,
    expires_at: expiresAt,
    revoked_at: null,
  };
}

export function findByRefreshHash(hash: string): AuthSession | undefined {
  const db = getDb();
  return db
    .prepare("SELECT * FROM auth_sessions WHERE refresh_token_hash = ?")
    .get(hash) as AuthSession | undefined;
}

export function findByTokenSelector(selector: string): AuthSession | undefined {
  const db = getDb();
  return db
    .prepare("SELECT * FROM auth_sessions WHERE token_selector = ? AND revoked_at IS NULL")
    .get(selector) as AuthSession | undefined;
}

export function revokeSession(id: string): void {
  const db = getDb();
  const now = new Date().toISOString();
  db.prepare("UPDATE auth_sessions SET revoked_at = ? WHERE id = ?").run(now, id);
}

export function revokeAllForUser(userId: string): void {
  const db = getDb();
  const now = new Date().toISOString();
  db.prepare(
    "UPDATE auth_sessions SET revoked_at = ? WHERE user_id = ? AND revoked_at IS NULL"
  ).run(now, userId);
}

export function cleanupExpiredAndAbandoned(
  expiredBefore: string,
  revokedBefore: string,
  abandonedBefore: string
): number {
  const db = getDb();
  const result = db.prepare(
    `DELETE FROM auth_sessions
     WHERE expires_at < ?
        OR (revoked_at IS NOT NULL AND revoked_at < ?)
        OR (created_at < ? AND revoked_at IS NULL)`
  ).run(expiredBefore, revokedBefore, abandonedBefore);
  return result.changes;
}
