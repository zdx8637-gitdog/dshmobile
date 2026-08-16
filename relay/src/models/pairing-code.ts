import { getDb } from "../db/connection.js";
import { generateId } from "../lib/id-generator.js";
import type { PairingCode } from "../types/entities.js";

export function createCode(params: {
  userId: string;
  codeHash: string;
  ttlSeconds: number;
}): PairingCode {
  const db = getDb();
  const now = new Date().toISOString();
  const id = generateId();
  const expiresAt = new Date(Date.now() + params.ttlSeconds * 1000).toISOString();

  db.prepare(
    `INSERT INTO pairing_codes (id, user_id, code_hash, expires_at, used_at, device_id, created_at)
     VALUES (?, ?, ?, ?, NULL, NULL, ?)`
  ).run(id, params.userId, params.codeHash, expiresAt, now);

  return {
    id,
    user_id: params.userId,
    code_hash: params.codeHash,
    expires_at: expiresAt,
    used_at: null,
    device_id: null,
    created_at: now,
  };
}

export function listByUser(userId: string): PairingCode[] {
  const db = getDb();
  return db
    .prepare(
      "SELECT * FROM pairing_codes WHERE user_id = ? AND used_at IS NULL AND expires_at > ? ORDER BY created_at DESC"
    )
    .all(userId, new Date().toISOString()) as PairingCode[];
}

export function findById(id: string): PairingCode | undefined {
  const db = getDb();
  return db
    .prepare("SELECT * FROM pairing_codes WHERE id = ?")
    .get(id) as PairingCode | undefined;
}

export function findByIdAndUser(
  id: string,
  userId: string
): PairingCode | undefined {
  const db = getDb();
  return db
    .prepare("SELECT * FROM pairing_codes WHERE id = ? AND user_id = ?")
    .get(id, userId) as PairingCode | undefined;
}

/** 按码哈希找"未使用且未过期"的配对码（verify 用，无登录态）。 */
export function findByCodeHash(codeHash: string): PairingCode | undefined {
  const db = getDb();
  return db
    .prepare(
      "SELECT * FROM pairing_codes WHERE code_hash = ? AND used_at IS NULL AND expires_at > ?"
    )
    .get(codeHash, new Date().toISOString()) as PairingCode | undefined;
}

export function markUsed(id: string, deviceId: string | null): void {
  const db = getDb();
  const now = new Date().toISOString();
  db.prepare("UPDATE pairing_codes SET used_at = ?, device_id = ? WHERE id = ?").run(
    now,
    deviceId,
    id
  );
}

export function cancelCode(id: string): void {
  const db = getDb();
  const now = new Date().toISOString();
  db.prepare("UPDATE pairing_codes SET used_at = ? WHERE id = ?").run(now, id);
}
