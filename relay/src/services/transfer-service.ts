// Data plane：文件传输 spool 管理。
// 控制面（WS 信封）只传 transfer.deliver / transfer.progress；文件字节经
// REST 分块上传进 spool（uploading → ready → delivered），投递完成后删除，
// TTL 兜底清理。relay 不长期存用户文件。
import { randomUUID } from "node:crypto";
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { closeSync, existsSync, mkdirSync, openSync, writeSync } from "node:fs";
import { rm, stat } from "node:fs/promises";
import path from "node:path";
import { config } from "../config.js";
import { AppError } from "../lib/errors.js";
import { logger } from "../lib/logger.js";
import { relayManager } from "../ws/relay.js";

export type TransferStatus = "uploading" | "ready" | "delivered" | "failed";

export interface Transfer {
  transferId: string;
  userId: string;
  deviceId: string;
  fileId: string;
  name: string;
  size: number;
  sha256: string;
  targetPath: string;
  received: number;
  status: TransferStatus;
  createdAt: number;
  deliveredAt: number | null;
  error: string | null;
}

const transfers = new Map<string, Transfer>();
let sweepTimer: ReturnType<typeof setInterval> | null = null;

function spoolPath(transferId: string): string {
  return path.join(config.spoolDir, transferId);
}

function ensureSpoolDir(): void {
  mkdirSync(config.spoolDir, { recursive: true });
}

function startSweep(): void {
  if (sweepTimer) return;
  sweepTimer = setInterval(() => {
    sweep().catch((err) => logger.error({ err: String(err?.message ?? err) }, "transfer sweep failed"));
  }, 5 * 60 * 1000);
  if (sweepTimer.unref) sweepTimer.unref();
}

export function get(transferId: string): Transfer | undefined {
  return transfers.get(transferId);
}

/** 幂等 announce：同（用户, 设备, fileId）的活动传输直接复用（断点续传/去重）。 */
export function announce(
  userId: string,
  input: {
    deviceId: string;
    fileId: string;
    name: string;
    size: number;
    sha256: string;
    targetPath: string;
  },
): Transfer {
  const active = [...transfers.values()].find(
    (t) =>
      t.userId === userId &&
      t.deviceId === input.deviceId &&
      t.fileId === input.fileId &&
      (t.status === "uploading" || t.status === "ready"),
  );
  if (active) return active;

  if (input.size <= 0 || input.size > config.maxTransferSizeBytes) {
    throw new AppError(400, "BAD_SIZE", "size out of range");
  }
  if (!/^[0-9a-f]{64}$/.test(input.sha256)) {
    throw new AppError(400, "BAD_SHA256", "invalid sha256");
  }
  if (!/^[0-9a-f]{64}$/.test(input.fileId)) {
    throw new AppError(400, "BAD_FILE_ID", "invalid fileId");
  }
  ensureSpoolDir();
  const t: Transfer = {
    transferId: randomUUID(),
    userId,
    deviceId: input.deviceId,
    fileId: input.fileId,
    name: input.name,
    size: input.size,
    sha256: input.sha256,
    targetPath: input.targetPath,
    received: 0,
    status: "uploading",
    createdAt: Date.now(),
    deliveredAt: null,
    error: null,
  };
  transfers.set(t.transferId, t);
  startSweep();
  logger.info({ transferId: t.transferId, deviceId: t.deviceId, fileId: t.fileId, size: t.size }, "transfer announced");
  return t;
}

/** 分块追加：offset 必须等于已收字节数（服务端强校验，防乱序/覆盖/断点错位）。 */
export function appendChunk(transferId: string, offset: number, data: Buffer): number {
  const t = transfers.get(transferId);
  if (!t) throw new AppError(404, "NOT_FOUND", "transfer not found");
  if (t.status !== "uploading") {
    throw new AppError(409, "WRONG_STATE", "transfer not accepting chunks");
  }
  if (offset !== t.received) {
    throw new AppError(409, "CHUNK_OFFSET_MISMATCH", `expected offset ${t.received}, got ${offset}`);
  }
  if (t.received + data.length > t.size) {
    throw new AppError(400, "SIZE_EXCEEDED", "chunk exceeds declared size");
  }
  const fd = openSync(spoolPath(t.transferId), "a");
  try {
    writeSync(fd, data);
  } finally {
    closeSync(fd);
  }
  t.received += data.length;
  return t.received;
}

async function sha256File(p: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = createHash("sha256");
    const stream = createReadStream(p);
    stream.on("data", (c) => hash.update(c));
    stream.on("error", reject);
    stream.on("end", () => resolve(hash.digest("hex")));
  });
}

/** 收尾：校验 size + sha256 → ready → 通知 bridge 投递（桥离线则待其上线重投）。 */
export async function complete(transferId: string): Promise<Transfer> {
  const t = transfers.get(transferId);
  if (!t) throw new AppError(404, "NOT_FOUND", "transfer not found");
  if (t.status !== "uploading") {
    throw new AppError(409, "WRONG_STATE", "transfer not completable");
  }
  if (t.received !== t.size) {
    throw new AppError(409, "INCOMPLETE", `received ${t.received}/${t.size}`);
  }
  const hash = await sha256File(spoolPath(transferId));
  if (hash !== t.sha256) {
    t.status = "failed";
    t.error = "checksum-mismatch";
    throw new AppError(422, "CHECKSUM_MISMATCH", "sha256 mismatch");
  }
  t.status = "ready";
  logger.info({ transferId, fileId: t.fileId }, "transfer ready, requesting deliver");
  deliver(t).catch((err) => {
    const msg = String(err?.message ?? err);
    logger.error({ transferId, err: msg }, "transfer deliver failed");
    if (t.status === "ready") {
      t.status = "failed";
      t.error = msg;
    }
  });
  return t;
}

/** 向 bridge 下发投递指令并等待回执。 */
async function deliver(t: Transfer): Promise<void> {
  if (!relayManager.isBridgeOnline(t.deviceId)) {
    return; // 桥离线：保持 ready，桥上线后 redeliverForDevice 重投
  }
  const payload = {
    transferId: t.transferId,
    fileId: t.fileId,
    name: t.name,
    size: t.size,
    sha256: t.sha256,
    targetPath: t.targetPath,
  };
  const resp = await relayManager.sendRequestToBridge(
    t.deviceId,
    "transfer.deliver",
    payload,
    config.transferDeliverTimeoutMs,
  );
  if (resp?.ok !== true) {
    throw new Error(String(resp?.error?.message ?? "deliver rejected by bridge"));
  }
  t.status = "delivered";
  t.deliveredAt = Date.now();
  logger.info({ transferId: t.transferId, path: String(resp?.data?.path ?? "") }, "transfer delivered");
}

/** 桥上线时重投该设备所有 ready 的传输。 */
export function redeliverForDevice(deviceId: string): void {
  for (const t of transfers.values()) {
    if (t.deviceId === deviceId && t.status === "ready") {
      deliver(t).catch((err) => {
        logger.error({ transferId: t.transferId, err: String(err?.message ?? err) }, "redeliver failed");
        if (t.status === "ready") {
          t.status = "failed";
          t.error = String(err?.message ?? err);
        }
      });
    }
  }
}

/** bridge 下载流（仅 ready 状态）。 */
export function openDownload(transferId: string) {
  const t = transfers.get(transferId);
  if (!t) throw new AppError(404, "NOT_FOUND", "transfer not found");
  if (t.status !== "ready") {
    throw new AppError(409, "WRONG_STATE", `transfer is ${t.status}, not downloadable`);
  }
  return createReadStream(spoolPath(transferId));
}

/** 兜底清理：TTL 过期的任何状态、delivered 超宽限期的 spool 文件。 */
export async function sweep(now: number = Date.now()): Promise<number> {
  let removed = 0;
  for (const [id, t] of transfers) {
    const expired = now - t.createdAt > config.transferTTLMs;
    const deliveredGrace = t.deliveredAt !== null && now - t.deliveredAt > config.transferDeliveredGraceMs;
    if (expired || deliveredGrace) {
      transfers.delete(id);
      const p = spoolPath(id);
      try {
        if (existsSync(p)) {
          await rm(p, { force: true });
          removed++;
        }
      } catch (err: any) {
        logger.error({ transferId: id, err: err?.message }, "spool delete failed");
      }
      logger.info({ transferId: id, status: t.status }, "transfer swept");
    }
  }
  return removed;
}

/** 供测试与状态接口使用。 */
export function stats() {
  return { activeTransfers: transfers.size };
}

export function spoolFileSize(transferId: string): Promise<number> {
  return stat(spoolPath(transferId))
    .then((s) => s.size)
    .catch(() => 0);
}
