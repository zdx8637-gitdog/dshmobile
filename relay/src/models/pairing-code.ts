import { getDb } from "../db/connection.js";
import { generateId } from "../lib/id-generator.js";
import type { PairingCode } from "../types/entities.js";

const ACTIVE = "used_at IS NULL AND expires_at > ?";

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
    `INSERT INTO pairing_codes (id, user_id, code_hash, expires_at, used_at, device_id, created_at, request_secret_hash, granted_to_user_id)
     VALUES (?, ?, ?, ?, NULL, NULL, ?, NULL, NULL)`
  ).run(id, params.userId, params.codeHash, expiresAt, now);

  return {
    id,
    user_id: params.userId,
    code_hash: params.codeHash,
    expires_at: expiresAt,
    used_at: null,
    device_id: null,
    created_at: now,
    request_secret_hash: null,
    granted_to_user_id: null,
  };
}

/** 设备授权码（S2，匿名出码）：user_id 为空，领取凭证哈希必填。 */
export function createDeviceCode(params: {
  codeHash: string;
  requestSecretHash: string;
  ttlSeconds: number;
}): PairingCode {
  const db = getDb();
  const now = new Date().toISOString();
  const id = generateId();
  const expiresAt = new Date(Date.now() + params.ttlSeconds * 1000).toISOString();

  db.prepare(
    `INSERT INTO pairing_codes (id, user_id, code_hash, expires_at, used_at, device_id, created_at, request_secret_hash, granted_to_user_id)
     VALUES (?, NULL, ?, ?, NULL, NULL, ?, ?, NULL)`
  ).run(id, params.codeHash, expiresAt, now, params.requestSecretHash);

  return {
    id,
    user_id: null,
    code_hash: params.codeHash,
    expires_at: expiresAt,
    used_at: null,
    device_id: null,
    created_at: now,
    request_secret_hash: params.requestSecretHash,
    granted_to_user_id: null,
  };
}

export function listByUser(userId: string): PairingCode[] {
  const db = getDb();
  return db
    .prepare(
      `SELECT * FROM pairing_codes WHERE user_id = ? AND ${ACTIVE} ORDER BY created_at DESC`
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

/** 按码哈希找"未使用且未过期"的**账号码**（verify 方向一用；排除匿名授权码）。 */
export function findByUserCodeHash(codeHash: string): PairingCode | undefined {
  const db = getDb();
  return db
    .prepare(
      `SELECT * FROM pairing_codes WHERE code_hash = ? AND user_id IS NOT NULL AND ${ACTIVE}`
    )
    .get(codeHash, new Date().toISOString()) as PairingCode | undefined;
}

/** 授权用：按 id 找"未使用且未过期"的任意码。 */
export function findActiveById(id: string): PairingCode | undefined {
  const db = getDb();
  return db
    .prepare(`SELECT * FROM pairing_codes WHERE id = ? AND ${ACTIVE}`)
    .get(id, new Date().toISOString()) as PairingCode | undefined;
}

/** 轮询用：按领取凭证哈希找"未使用且未过期"的设备授权码。 */
export function findByRequestSecretHash(
  secretHash: string
): PairingCode | undefined {
  const db = getDb();
  return db
    .prepare(
      `SELECT * FROM pairing_codes WHERE request_secret_hash = ? AND ${ACTIVE}`
    )
    .get(secretHash, new Date().toISOString()) as PairingCode | undefined;
}

/** 手机授权：把设备授权码绑定到账号（幂等：同账号重复授权无副作用）。 */
export function setGranted(id: string, userId: string): void {
  const db = getDb();
  db.prepare(
    "UPDATE pairing_codes SET granted_to_user_id = ? WHERE id = ? AND granted_to_user_id IS NULL"
  ).run(userId, id);
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
