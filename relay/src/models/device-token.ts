import { getDb } from "../db/connection.js";
import { generateId } from "../lib/id-generator.js";
import type { DeviceToken } from "../types/entities.js";
import { hashSecret, verifySecret } from "../lib/hash.js";

export async function createDeviceToken(params: {
  deviceId: string;
  userId: string;
  tokenHash: string;
}): Promise<DeviceToken> {
  const db = getDb();
  const now = new Date().toISOString();
  const id = generateId();

  db.prepare(
    `INSERT INTO device_tokens (id, device_id, user_id, token_hash, created_at, expires_at, revoked_at)
     VALUES (?, ?, ?, ?, ?, NULL, NULL)`
  ).run(id, params.deviceId, params.userId, params.tokenHash, now);

  return {
    id,
    device_id: params.deviceId,
    user_id: params.userId,
    token_hash: params.tokenHash,
    created_at: now,
    expires_at: null,
    revoked_at: null,
  };
}

export async function verifyDeviceToken(
  plainToken: string,
  deviceId: string
): Promise<{ valid: boolean; userId?: string }> {
  const db = getDb();
  const tokens = db
    .prepare("SELECT * FROM device_tokens WHERE device_id = ? AND revoked_at IS NULL")
    .all(deviceId) as DeviceToken[];

  for (const token of tokens) {
    const match = await verifySecret(plainToken, token.token_hash);
    if (match) {
      return { valid: true, userId: token.user_id };
    }
  }

  return { valid: false };
}

export function revokeDeviceTokens(deviceId: string): void {
  const db = getDb();
  const now = new Date().toISOString();
  db.prepare("UPDATE device_tokens SET revoked_at = ? WHERE device_id = ? AND revoked_at IS NULL").run(now, deviceId);
}
