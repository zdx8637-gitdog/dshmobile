import crypto from "node:crypto";
import { config } from "../config.js";
import { hashSecret, hashDeterministic } from "../lib/hash.js";
import * as pairingCodeModel from "../models/pairing-code.js";
import * as auditLog from "../models/audit-log.js";
import * as userModel from "../models/user.js";
import * as authService from "./auth-service.js";
import { AuthError, ConflictError, NotFoundError } from "../lib/errors.js";
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
  const code = pairingCodeModel.findByUserCodeHash(codeHash);
  if (!code) {
    throw new AuthError("Invalid or expired pairing code", false);
  }

  pairingCodeModel.markUsed(code.id, null);

  const userId = code.user_id as string;
  const { accessToken, refreshToken } = await authService.issueSession(userId);
  const user = userModel.findById(userId);

  auditLog.insertLog({
    userId,
    action: "pairing_code.verify",
    targetType: "pairing_code",
    targetId: code.id,
    ipHash: ip ? await hashSecret(ip) : null,
  });

  return {
    accessToken,
    refreshToken,
    userId,
    username: user?.username ?? "",
  };
}

// ---------------- S2：设备授权码流（RFC 8628） ----------------

/**
 * 匿名出码（插件未登录时）：生成 6 位码 + 领取凭证 requestSecret。
 * 码与凭证都只存哈希；requestSecret 明文只返回一次，只有持码方轮询能取走结果。
 */
export function createDeviceCode(): {
  id: string;
  code: string;
  requestSecret: string;
  expiresAt: string;
} {
  const plaintext = generatePlaintextCode();
  const requestSecret = crypto.randomBytes(32).toString("base64url");

  const code = pairingCodeModel.createDeviceCode({
    codeHash: hashDeterministic(plaintext),
    requestSecretHash: hashDeterministic(requestSecret),
    ttlSeconds: config.pairingCodeTTL,
  });

  auditLog.insertLog({
    action: "pairing_code.device_create",
    targetType: "pairing_code",
    targetId: code.id,
  });

  return {
    id: code.id,
    code: plaintext,
    requestSecret,
    expiresAt: code.expires_at,
  };
}

/** 手机（已登录）授权：把设备授权码绑定到该账号。同账号重复授权幂等。 */
export function grant(userId: string, codeId: string): void {
  const code = pairingCodeModel.findActiveById(codeId);
  if (!code) throw new NotFoundError("Pairing code not found or expired");
  if (code.user_id !== null) throw new ConflictError("Pairing code is not a device grant code");
  if (code.granted_to_user_id !== null && code.granted_to_user_id !== userId) {
    // 码已被别人绑定：不暴露细节，按无效处理
    throw new NotFoundError("Pairing code not found or expired");
  }

  pairingCodeModel.setGranted(codeId, userId);

  auditLog.insertLog({
    userId,
    action: "pairing_code.grant",
    targetType: "pairing_code",
    targetId: codeId,
  });
}

/**
 * 插件轮询（每 ~2s）：凭 requestSecret 查询授权状态。
 * 未授权 → pending；已授权 → 核销并一次性签发账号会话（取走即作废）。
 */
export async function pollStatus(
  codeId: string,
  requestSecret: string
): Promise<
  | { status: "pending" }
  | {
      status: "granted";
      accessToken: string;
      refreshToken: string;
      user: { id: string; username: string };
    }
> {
  const code = pairingCodeModel.findByRequestSecretHash(
    hashDeterministic(requestSecret)
  );
  if (!code || code.id !== codeId) {
    throw new AuthError("Invalid or expired pairing secret", false);
  }
  if (code.granted_to_user_id === null) {
    return { status: "pending" };
  }

  const userId = code.granted_to_user_id;
  const { accessToken, refreshToken } = await authService.issueSession(userId);
  pairingCodeModel.markUsed(code.id, null);
  const user = userModel.findById(userId);

  auditLog.insertLog({
    userId,
    action: "pairing_code.consume",
    targetType: "pairing_code",
    targetId: code.id,
  });

  return {
    status: "granted",
    accessToken,
    refreshToken,
    user: { id: userId, username: user?.username ?? "" },
  };
}
