import crypto from "node:crypto";
import { config } from "../config.js";
import { hashSecret } from "../lib/hash.js";
import * as pairingCodeModel from "../models/pairing-code.js";
import * as auditLog from "../models/audit-log.js";
import { NotFoundError } from "../lib/errors.js";
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
  const codeHash = await hashSecret(plaintext);

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
