// Data plane REST 面：announce / 分块上传 / 状态 / 收尾 / 设备下载。
// 归属校验：用户面要求 userId 拥有 deviceId；下载面要求 deviceToken 的设备一致。
import express, { Router, Request, Response, NextFunction } from "express";
import { z } from "zod";
import { asyncHandler } from "../lib/async-handler.js";
import { ok } from "../lib/response.js";
import { authenticate } from "../middleware/authenticate.js";
import { verifyDeviceToken, verifyAccessToken } from "../lib/jwt.js";
import { config } from "../config.js";
import { AppError, AuthError, ValidationError } from "../lib/errors.js";
import * as deviceModel from "../models/device.js";
import * as transferService from "../services/transfer-service.js";

const router = Router();
router.use("/transfers", authenticate);

const announceSchema = z.object({
  deviceId: z.string().min(1).max(64),
  fileId: z.string().regex(/^[0-9a-f]{64}$/),
  name: z.string().min(1).max(255),
  size: z.number().int().positive(),
  sha256: z.string().regex(/^[0-9a-f]{64}$/),
  targetPath: z.string().min(1).max(1024),
  direction: z.enum(["upload", "download"]).optional(),
});

function requireOwnedDevice(req: Request, deviceId: string) {
  const d = deviceModel.findByIdAndUser(deviceId, req.userId!);
  if (!d || d.revoked_at) {
    throw new AppError(404, "DEVICE_NOT_FOUND", "device not found");
  }
  return d;
}

function requireOwnedTransfer(req: Request, transferId: string) {
  const t = transferService.get(transferId);
  if (!t || t.userId !== req.userId) {
    throw new AppError(404, "NOT_FOUND", "transfer not found");
  }
  return t;
}

router.post(
  "/transfers",
  asyncHandler(async (req: Request, res: Response, _next: NextFunction) => {
    const body = announceSchema.safeParse(req.body);
    if (!body.success) {
      throw new ValidationError(body.error.errors.map((e) => e.message).join("; "));
    }
    requireOwnedDevice(req, body.data.deviceId);
    const t = transferService.announce(req.userId!, body.data);
    ok(res, { transferId: t.transferId, received: t.received, status: t.status }, 201);
  }),
);

router.put(
  "/transfers/:transferId/chunks",
  express.raw({ type: () => true, limit: config.transferChunkMaxBytes }),
  asyncHandler(async (req: Request, res: Response, _next: NextFunction) => {
    requireOwnedTransfer(req, req.params.transferId);
    const offset = parseInt(String(req.headers["x-chunk-offset"] ?? ""), 10);
    if (!Number.isInteger(offset) || offset < 0) {
      throw new AppError(400, "BAD_OFFSET", "missing or invalid X-Chunk-Offset header");
    }
    const received = transferService.appendChunk(
      req.params.transferId,
      offset,
      Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0),
    );
    ok(res, { received });
  }),
);

router.get(
  "/transfers/:transferId",
  asyncHandler(async (req: Request, res: Response, _next: NextFunction) => {
    const t = requireOwnedTransfer(req, req.params.transferId);
    ok(res, {
      transferId: t.transferId,
      fileId: t.fileId,
      name: t.name,
      size: t.size,
      received: t.received,
      status: t.status,
      targetPath: t.targetPath,
    });
  }),
);

router.post(
  "/transfers/:transferId/complete",
  asyncHandler(async (req: Request, res: Response, _next: NextFunction) => {
    requireOwnedTransfer(req, req.params.transferId);
    const t = await transferService.complete(req.params.transferId);
    ok(res, { transferId: t.transferId, status: t.status });
  }),
);

// ---- 设备下载面（deviceToken 鉴权，不挂用户 authenticate）----
export const transferDownloadRouter = Router();

transferDownloadRouter.get(
  "/transfers/:transferId/download",
  asyncHandler(async (req: Request, res: Response, _next: NextFunction) => {
    const header = req.headers.authorization;
    if (!header || !header.startsWith("Bearer ")) {
      throw new AuthError("Missing or invalid authorization header", false);
    }
    const token = header.slice(7);
    const t = transferService.get(req.params.transferId);
    // 双面鉴权：设备 token（bridge 投递拉取，要求设备一致）
    // 或用户 token（手机回显/反向传输拉取，要求 owner 一致）
    let authorized = false;
    try {
      const { deviceId, userId: deviceUserId } = verifyDeviceToken(token);
      authorized = Boolean(t && t.deviceId === deviceId && t.userId === deviceUserId);
    } catch {
      try {
        const { userId } = verifyAccessToken(token);
        authorized = Boolean(t && t.userId === userId);
      } catch {
        authorized = false;
      }
    }
    if (!authorized) {
      throw new AppError(404, "NOT_FOUND", "transfer not found");
    }
    res.setHeader("content-type", "application/octet-stream");
    res.setHeader("content-length", String(t!.size));
    res.setHeader("x-dshmobile-file-name", encodeURIComponent(t!.name));
    transferService.openDownload(req.params.transferId).pipe(res);
  }),
);

export default router;
