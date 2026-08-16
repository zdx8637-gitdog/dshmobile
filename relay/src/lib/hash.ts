import bcrypt from "bcrypt";
import crypto from "node:crypto";
import { config } from "../config.js";

export async function hashSecret(plain: string): Promise<string> {
  return bcrypt.hash(plain, config.bcryptRounds);
}

export async function verifySecret(plain: string, hash: string): Promise<boolean> {
  return bcrypt.compare(plain, hash);
}

/** 确定性哈希（SHA-256 hex）：用于短码（配对码）存储/查找。
 *  bcrypt 随机盐的哈希不可直接比对，短码的防爆破靠限流 + TTL，而非慢哈希。 */
export function hashDeterministic(plain: string): string {
  return crypto.createHash("sha256").update(plain, "utf8").digest("hex");
}
