import crypto from "node:crypto";
import * as deviceModel from "../models/device.js";
import * as deviceTokenModel from "../models/device-token.js";
import * as auditLog from "../models/audit-log.js";
import { hashSecret } from "../lib/hash.js";
import { signDeviceToken } from "../lib/jwt.js";
import { NotFoundError } from "../lib/errors.js";
import { relayManager } from "../ws/relay.js";
import type { DeviceResponse, RegisterDeviceResponse } from "../types/api.js";

function toDeviceResponse(d: any): DeviceResponse {
  return {
    id: d.id,
    label: d.label,
    platform: d.platform ?? "other",
    status: d.status,
    createdAt: d.created_at,
    pairedAt: d.paired_at,
    lastSeenAt: d.last_seen_at,
    revokedAt: d.revoked_at,
  };
}

export function create(userId: string, label: string): DeviceResponse {
  const device = deviceModel.createDevice({ userId, label });

  auditLog.insertLog({
    userId,
    action: "device.create",
    targetType: "device",
    targetId: device.id,
  });

  return toDeviceResponse(device);
}

export async function register(
  userId: string,
  params: { label: string; platform: "windows" | "android" | "web" | "other"; clientDeviceKey?: string }
): Promise<RegisterDeviceResponse> {
  // Deduplication: if clientDeviceKey is provided, check for existing device
  if (params.clientDeviceKey) {
    const existing = deviceModel.findByDedupKey(userId, params.platform, params.clientDeviceKey);
    if (existing) {
      // Same device re-registering: rotate token, keep deviceId；
      // 显示名变了就更新（改名不产生新行）。
      const newDeviceToken = signDeviceToken(existing.id, userId);
      deviceModel.setStatus(existing.id, "offline");
      if (existing.label !== params.label) {
        deviceModel.updateLabel(existing.id, params.label);
      }

      await auditLog.insertLog({
        userId,
        action: "device.reregister",
        targetType: "device",
        targetId: existing.id,
      });

      return {
        device: toDeviceResponse({ ...existing, label: params.label }),
        deviceToken: newDeviceToken,
      };
    }
  }

  // New device: create fresh record
  const device = deviceModel.createDevice({
    userId,
    label: params.label,
    platform: params.platform,
    clientDeviceKey: params.clientDeviceKey,
  });

  // Generate device token (JWT-signed, not stored as plaintext)
  const deviceToken = signDeviceToken(device.id, userId);

  await auditLog.insertLog({
    userId,
    action: "device.register",
    targetType: "device",
    targetId: device.id,
  });

  return { device: toDeviceResponse(device), deviceToken };
}

export function list(userId: string): DeviceResponse[] {
  const devices = deviceModel.listByUser(userId);
  return devices.map(toDeviceResponse);
}

export function get(userId: string, deviceId: string): DeviceResponse {
  const device = deviceModel.findByIdAndUser(deviceId, userId);
  if (!device) throw new NotFoundError("Device not found");
  return toDeviceResponse(device);
}

export function revoke(userId: string, deviceId: string): void {
  const device = deviceModel.findByIdAndUser(deviceId, userId);
  if (!device) throw new NotFoundError("Device not found");

  deviceModel.revoke(deviceId);
  deviceTokenModel.revokeDeviceTokens(deviceId);
  // 踢掉在线 bridge 与客户端（4003 同时是 bridge 重注册自愈的触发信号）
  relayManager.kickDevice(deviceId, 4003, "device revoked");

  auditLog.insertLog({
    userId,
    action: "device.revoke",
    targetType: "device",
    targetId: deviceId,
  });
}
