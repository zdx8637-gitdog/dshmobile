import crypto from "node:crypto";
import { config } from "../config.js";
import { hashSecret, hashDeterministic } from "../lib/hash.js";
import * as pairingCodeModel from "../models/pairing-code.js";
import * as auditLog from "../models/audit-log.js";
import * as userModel from "../models/user.js";
import * as authService from "./auth-service.js";
import { AuthError, NotFoundError } from "../lib/errors.js";
import type { CreatePairingCodeResponse, PairingCodeResponse } from "../types/api.js";

function generatePlaintextCode(): string {
  const max = Math.pow(10, config.pairingCodeLength) - 1;
  const num = crypto.randomInt(0, max);
  return num.toString().padStart(config.pairingCodeLength, "0");
}

export async function create(
  userId: string
): Promise<CreatePairingCodeResponse> {
  const plaintext = generatePlaintextCode();
  // 短码用确定性哈希存储（SHA-256）：verify 需按哈希查找；防爆破靠限流 + TTL。
  const codeHash = hashDeterministic(plaintext);

  const code = pairingCodeModel.createCode({
    userId,
    codeHash,
    ttlSeconds: config.pairingCodeTTL,
  });

  auditLog.insertLog({
    userId,
    action: "pairing_code.create",
    targetType: "pairing_code",
    targetId: code.id,
  });

  return {
    id: code.id,
    code: plaintext,
    expiresAt: code.expires_at,
  };
}

export function list(userId: string): PairingCodeResponse[] {
  const codes = pairingCodeModel.listByUser(userId);
  return codes.map((c) => ({
    id: c.id,
    expiresAt: c.expires_at,
    usedAt: c.used_at,
    createdAt: c.created_at,
  }));
}

export function cancel(userId: string, codeId: string): void {
  const code = pairingCodeModel.findByIdAndUser(codeId, userId);
  if (!code) throw new NotFoundError("Pairing code not found");

  pairingCodeModel.cancelCode(codeId);

  auditLog.insertLog({
    userId,
    action: "pairing_code.cancel",
    targetType: "pairing_code",
    targetId: codeId,
  });
}

/**
 * 核销配对码（扫码登录方向一）：无登录态，凭 6 位码换取码主账号的会话 token。
 * 一次性：核销即标记 used；码错误/过期/已用一律 401（不暴露码是否存在）。
 */
export async function verify(
  plaintextCode: string,
  ip?: string
): Promise<{
  accessToken: string;
  refreshToken: string;
  userId: string;
  username: string;
}> {
  const codeHash = hashDeterministic(plaintextCode);
  const code = pairingCodeModel.findByCodeHash(codeHash);
  if (!code) {
    throw new AuthError("Invalid or expired pairing code", false);
  }

  pairingCodeModel.markUsed(code.id, null);

  const { accessToken, refreshToken } = await authService.issueSession(code.user_id);
  const user = userModel.findById(code.user_id);

  auditLog.insertLog({
    userId: code.user_id,
    action: "pairing_code.verify",
    targetType: "pairing_code",
    targetId: code.id,
    ipHash: ip ? await hashSecret(ip) : null,
  });

  return {
    accessToken,
    refreshToken,
    userId: code.user_id,
    username: user?.username ?? "",
  };
}
