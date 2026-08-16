import { getDb } from "../db/connection.js";
import { generateId } from "../lib/id-generator.js";
import { logger } from "../lib/logger.js";
import type { AuditLog } from "../types/entities.js";

export function insertLog(params: {
  userId?: string | null;
  deviceId?: string | null;
  action: string;
  targetType: string;
  targetId?: string | null;
  ipHash?: string | null;
}): void {
  try {
    const db = getDb();
    const id = generateId();
    const now = new Date().toISOString();

    db.prepare(
      `INSERT INTO audit_logs (id, user_id, device_id, action, target_type, target_id, ip_hash, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      id,
      params.userId ?? null,
      params.deviceId ?? null,
      params.action,
      params.targetType,
      params.targetId ?? null,
      params.ipHash ?? null,
      now
    );
  } catch (err) {
    logger.warn({ err }, "Failed to write audit log");
  }
}

export function getLogsByUser(userId: string): AuditLog[] {
  const db = getDb();
  return db
    .prepare("SELECT * FROM audit_logs WHERE user_id = ? ORDER BY created_at DESC LIMIT 100")
    .all(userId) as AuditLog[];
}
