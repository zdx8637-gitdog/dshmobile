import { getDb } from "../db/connection.js";
import { generateId } from "../lib/id-generator.js";
import type { Device } from "../types/entities.js";

export function createDevice(params: {
  userId: string;
  label: string;
  platform?: string;
  clientDeviceKey?: string;
}): Device {
  const db = getDb();
  const now = new Date().toISOString();
  const id = generateId();
  const platform = params.platform ?? "other";

  db.prepare(
    `INSERT INTO devices (id, user_id, label, platform, client_device_key, status, created_at, paired_at, last_seen_at, revoked_at)
     VALUES (?, ?, ?, ?, ?, 'offline', ?, NULL, NULL, NULL)`
  ).run(id, params.userId, params.label, platform, params.clientDeviceKey ?? null, now);

  return {
    id,
    user_id: params.userId,
    label: params.label,
    platform,
    status: "offline",
    created_at: now,
    paired_at: null,
    last_seen_at: null,
    revoked_at: null,
  };
}

export function listByUser(userId: string): Device[] {
  const db = getDb();
  return db
    .prepare("SELECT * FROM devices WHERE user_id = ? AND revoked_at IS NULL ORDER BY created_at DESC")
    .all(userId) as Device[];
}

export function findById(id: string): Device | undefined {
  const db = getDb();
  return db.prepare("SELECT * FROM devices WHERE id = ?").get(id) as Device | undefined;
}

export function findByIdAndUser(id: string, userId: string): Device | undefined {
  const db = getDb();
  return db
    .prepare("SELECT * FROM devices WHERE id = ? AND user_id = ?")
    .get(id, userId) as Device | undefined;
}

export function setStatus(id: string, status: "offline" | "online"): void {
  const db = getDb();
  const now = new Date().toISOString();
  const lastSeenAt = status === "online" ? now : undefined;
  if (lastSeenAt) {
    db.prepare("UPDATE devices SET status = ?, last_seen_at = ? WHERE id = ?").run(
      status,
      lastSeenAt,
      id
    );
  } else {
    db.prepare("UPDATE devices SET status = ? WHERE id = ?").run(status, id);
  }
}

export function revoke(id: string): void {
  const db = getDb();
  const now = new Date().toISOString();
  db.prepare("UPDATE devices SET revoked_at = ? WHERE id = ?").run(now, id);
}

/** 同 key 重注册时更新显示名（改名不换行）。 */
export function updateLabel(id: string, label: string): void {
  const db = getDb();
  db.prepare("UPDATE devices SET label = ? WHERE id = ?").run(label, id);
}

export function findByDedupKey(
  userId: string,
  platform: string,
  clientDeviceKey: string
): Device | undefined {
  const db = getDb();
  return db
    .prepare(
      `SELECT * FROM devices
       WHERE user_id = ? AND platform = ? AND client_device_key = ?
         AND revoked_at IS NULL`
    )
    .get(userId, platform, clientDeviceKey) as Device | undefined;
}
