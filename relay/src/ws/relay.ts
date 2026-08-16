import { WebSocket, WebSocketServer } from "ws";
import { IncomingMessage } from "node:http";
import { randomUUID } from "node:crypto";
import { config } from "../config.js";
import { logger } from "../lib/logger.js";
import { verifyAccessToken, verifyDeviceToken } from "../lib/jwt.js";
import * as deviceModel from "../models/device.js";
import {
  SCHEMA_VERSION,
  BLOCKED_MESSAGE_TYPES,
  type RemoteEnvelopeV1Request,
  type RemoteEnvelopeV1Response,
  type RemoteEnvelopeV1Event,
  type RemoteEnvelopeV1Heartbeat,
  type BridgeConnectParams,
  type ClientConnectParams,
  type CanonicalEvent,
  type CanonicalRequest,
} from "../types/protocol.js";

type RelayEnvelope = Record<string, unknown>;

// ---- Auth helpers ----

function parseAuthHeader(req: IncomingMessage): { type: "bearer" | "none"; token?: string } {
  const header = req.headers.authorization;
  if (header && header.startsWith("Bearer ")) {
    return { type: "bearer", token: header.slice(7) };
  }
  return { type: "none" };
}

function parseProtocolAuth(req: IncomingMessage): { type: "bearer" | "none"; token?: string } {
  const protocolHeader = req.headers["sec-websocket-protocol"];
  if (!protocolHeader) return { type: "none" };

  const protocols = protocolHeader.split(",").map((s) => s.trim()).filter(Boolean);

  // Format 1: ["bearer", "<accessToken>"] → "bearer, <accessToken>"
  const bearerIdx = protocols.indexOf("bearer");
  if (bearerIdx !== -1 && bearerIdx + 1 < protocols.length) {
    const token = protocols[bearerIdx + 1];
    if (token.length > 0) {
      return { type: "bearer", token };
    }
  }

  // Format 2: ["bearer.<base64url-token>"] → "bearer.<base64url-token>"
  for (const p of protocols) {
    if (p.startsWith("bearer.") && p.length > 7) {
      return { type: "bearer", token: p.slice(7) };
    }
  }

  return { type: "none" };
}

function resolveAuth(req: IncomingMessage): { type: "bearer" | "none"; token?: string } {
  const headerAuth = parseAuthHeader(req);
  if (headerAuth.type === "bearer") return headerAuth;
  return parseProtocolAuth(req);
}

// ---- Connection state ----

interface BridgeState {
  deviceId: string;
  userId: string;
  ws: WebSocket;
  connectedAt: number;
  lastHeartbeat: number;
}

interface ClientState {
  clientId: string;
  userId: string;
  targetDeviceId: string;
  ws: WebSocket;
  connectedAt: number;
}

interface PendingRequest {
  requestId: string;
  clientWs: WebSocket;
  deviceId: string;
  clientId: string;
  userId: string;
  createdAt: number;
  type: string;
  resourceSubscriptionId?: string;
}

interface ResourceSubscription {
  subscriptionId: string;
  clientWs: WebSocket;
  deviceId: string;
  clientId: string;
  userId: string;
  createdAt: number;
  lastSequence: number;
}

// ---- Relay Manager ----

class RelayManager {
  private bridges = new Map<string, BridgeState>();
  // targetDeviceId -> ClientState[]
  private clients = new Map<string, ClientState[]>();
  // requestId -> PendingRequest (for targeted response routing)
  private pendingRequests = new Map<string, PendingRequest>();
  // subscriptionId -> client subscription for resources.changed fanout
  private resourceSubscriptions = new Map<string, ResourceSubscription>();
  private heartbeatInterval: ReturnType<typeof setInterval> | null = null;
  private cleanupInterval: ReturnType<typeof setInterval> | null = null;

  private startCleanup() {
    if (this.cleanupInterval) return;
    this.cleanupInterval = setInterval(() => {
      const now = Date.now();
      const ttl = 60_000; // 60s TTL
      for (const [requestId, pending] of this.pendingRequests) {
        if (now - pending.createdAt > ttl) {
          logger.warn(
            { requestId, clientId: pending.clientId, deviceId: pending.deviceId },
            "pending request timed out - cleaning up"
          );
          if (pending.resourceSubscriptionId !== undefined) {
            this.removeResourceSubscription(pending.resourceSubscriptionId);
          }
          this.pendingRequests.delete(requestId);
        }
      }
    }, 15_000);
  }

  startHeartbeatCheck() {
    if (this.heartbeatInterval) return;
    // Check every 15 seconds
    this.heartbeatInterval = setInterval(() => {
      const now = Date.now();
      const timeout = 45_000; // 45s timeout
      for (const [deviceId, bridge] of this.bridges) {
        if (now - bridge.lastHeartbeat > timeout) {
          logger.warn(
            { deviceId, userId: bridge.userId },
            "bridge heartbeat timeout - marking offline"
          );
          bridge.ws.close(4001, "heartbeat timeout");
          this.removeBridge(deviceId, "heartbeat_timeout");
        }
      }
    }, 15_000);
  }

  stopHeartbeatCheck() {
    if (this.heartbeatInterval) {
      clearInterval(this.heartbeatInterval);
      this.heartbeatInterval = null;
    }
  }

  addBridge(deviceId: string, userId: string, ws: WebSocket): void {
    // If bridge already connected for this device, close old one
    const existing = this.bridges.get(deviceId);
    if (existing) {
      logger.warn(
        { deviceId },
        "duplicate bridge connection - closing old connection"
      );
      existing.ws.close(4000, "duplicate connection");
    }

    const state: BridgeState = {
      deviceId,
      userId,
      ws,
      connectedAt: Date.now(),
      lastHeartbeat: Date.now(),
    };
    this.bridges.set(deviceId, state);
    this.startHeartbeatCheck();
    logger.info(
      { deviceId, userId, bridgeCount: this.bridges.size },
      "bridge connected"
    );
    this.broadcastDeviceStatus(deviceId, userId, true, "bridge_connected");
  }

  removeBridge(deviceId: string, reason = "bridge_disconnected"): void {
    const bridge = this.bridges.get(deviceId);
    if (bridge) {
      this.bridges.delete(deviceId);
      logger.info(
        { deviceId, bridgeCount: this.bridges.size },
        "bridge disconnected"
      );
      this.broadcastDeviceStatus(deviceId, bridge.userId, false, reason);
    }
  }

  /** 设备被吊销/删除时：踢掉该设备的 bridge 与所有在线客户端。 */
  kickDevice(deviceId: string, code: number, reason: string): void {
    const bridge = this.bridges.get(deviceId);
    if (bridge) {
      this.bridges.delete(deviceId);
      logger.info({ deviceId, bridgeCount: this.bridges.size }, "bridge kicked");
      this.broadcastDeviceStatus(deviceId, bridge.userId, false, "device_revoked");
      try {
        bridge.ws.close(code, reason);
      } catch {}
    }
    const clients = this.clients.get(deviceId) ?? [];
    for (const client of clients) {
      logger.info({ clientId: client.clientId, deviceId }, "client kicked - device revoked");
      try {
        client.ws.close(code, reason);
      } catch {}
    }
    this.clients.delete(deviceId);
  }

  updateBridgeHeartbeat(deviceId: string): void {
    const bridge = this.bridges.get(deviceId);
    if (bridge) {
      bridge.lastHeartbeat = Date.now();
    }
  }

  isBridgeOnline(deviceId: string): boolean {
    const bridge = this.bridges.get(deviceId);
    return bridge !== undefined && bridge.ws.readyState === WebSocket.OPEN;
  }

  addClient(
    clientId: string,
    userId: string,
    targetDeviceId: string,
    ws: WebSocket
  ): void {
    const state: ClientState = {
      clientId,
      userId,
      targetDeviceId,
      ws,
      connectedAt: Date.now(),
    };
    const deviceClients = this.clients.get(targetDeviceId) ?? [];
    deviceClients.push(state);
    this.clients.set(targetDeviceId, deviceClients);
    logger.info(
      { clientId, userId, targetDeviceId, clientCount: deviceClients.length },
      "client connected"
    );
  }

  addResourceSubscription(input: {
    subscriptionId: string;
    client: ClientState;
    afterSequence: number;
  }): void {
    this.resourceSubscriptions.set(input.subscriptionId, {
      subscriptionId: input.subscriptionId,
      clientWs: input.client.ws,
      deviceId: input.client.targetDeviceId,
      clientId: input.client.clientId,
      userId: input.client.userId,
      createdAt: Date.now(),
      lastSequence: input.afterSequence,
    });
    logger.debug(
      {
        subscriptionId: input.subscriptionId,
        clientId: input.client.clientId,
        deviceId: input.client.targetDeviceId,
      },
      "resource subscription registered"
    );
  }

  removeResourceSubscription(subscriptionId: string): boolean {
    return this.resourceSubscriptions.delete(subscriptionId);
  }

  removeClient(ws: WebSocket): void {
    for (const [deviceId, deviceClients] of this.clients) {
      const idx = deviceClients.findIndex((c) => c.ws === ws);
      if (idx !== -1) {
        const client = deviceClients[idx];
        deviceClients.splice(idx, 1);
        if (deviceClients.length === 0) {
          this.clients.delete(deviceId);
        } else {
          this.clients.set(deviceId, deviceClients);
        }
        this.removeClientPendingRequests(ws);
        this.removeClientResourceSubscriptions(ws);
        logger.info(
          { clientId: client.clientId, deviceId },
          "client disconnected"
        );
        return;
      }
    }
  }

  findClientByWs(ws: WebSocket): ClientState | undefined {
    for (const deviceClients of this.clients.values()) {
      const found = deviceClients.find((c) => c.ws === ws);
      if (found) return found;
    }
    return undefined;
  }

  getBridgeForDevice(deviceId: string): BridgeState | undefined {
    return this.bridges.get(deviceId);
  }

  getClientsForDevice(deviceId: string): ClientState[] {
    return this.clients.get(deviceId) ?? [];
  }

  getResourceSubscribersForDevice(deviceId: string): ResourceSubscription[] {
    return Array.from(this.resourceSubscriptions.values()).filter(
      (subscription) =>
        subscription.deviceId === deviceId &&
        subscription.clientWs.readyState === WebSocket.OPEN
    );
  }

  // Route request from client to bridge, returns the client state for response routing
  routeRequestToBridge(
    client: ClientState,
    envelope: RelayEnvelope
  ): boolean {
    const bridge = this.bridges.get(client.targetDeviceId);
    if (!bridge || bridge.ws.readyState !== WebSocket.OPEN) {
      return false;
    }
    bridge.ws.send(JSON.stringify(envelope));
    const requestId = typeof envelope.requestId === "string" ? envelope.requestId : "unknown";
    const msgType = typeof envelope.type === "string" ? envelope.type : "unknown";
    this.trackPendingRequest(requestId, client, envelope);
    logger.debug(
      {
        requestId,
        type: msgType,
        deviceId: client.targetDeviceId,
        clientId: client.clientId,
      },
      "request routed to bridge"
    );
    return true;
  }

  // Route response/event from bridge back to client
  routeToClientByWs(
    ws: WebSocket,
    envelope: RelayEnvelope
  ): void {
    ws.send(JSON.stringify(envelope));
  }

  private broadcastDeviceStatus(
    deviceId: string,
    userId: string,
    online: boolean,
    reason: string
  ): void {
    const clients = this.getClientsForDevice(deviceId);
    if (clients.length === 0) {
      return;
    }

    const envelope: RelayEnvelope = {
      schemaVersion: 1,
      envelopeId: randomUUID(),
      kind: "event",
      type: "device.status",
      sentAt: new Date().toISOString(),
      actor: {
        role: "relay",
        userId,
      },
      target: {
        deviceId,
      },
      payload: {
        deviceId,
        online,
        reason,
      },
    };

    for (const client of clients) {
      if (client.ws.readyState === WebSocket.OPEN) {
        this.routeToClientByWs(client.ws, envelope);
      }
    }
  }

  getStats() {
    return {
      bridgeCount: this.bridges.size,
      clientCount: Array.from(this.clients.values()).reduce(
        (sum, arr) => sum + arr.length,
        0
      ),
      deviceCount: this.clients.size,
      pendingRequestCount: this.pendingRequests.size,
    };
  }

  trackPendingRequest(
    requestId: string,
    client: ClientState,
    envelope: RelayEnvelope
  ): void {
    const msgType = typeof envelope.type === "string" ? envelope.type : "unknown";
    const resourceSubscriptionId =
      msgType === "resources.subscribe" ? `pending:${requestId}` : undefined;
    if (resourceSubscriptionId !== undefined) {
      this.addResourceSubscription({
        subscriptionId: resourceSubscriptionId,
        client,
        afterSequence: getAfterSequence(envelope),
      });
    }
    this.pendingRequests.set(requestId, {
      requestId,
      clientWs: client.ws,
      deviceId: client.targetDeviceId,
      clientId: client.clientId,
      userId: client.userId,
      createdAt: Date.now(),
      type: msgType,
      resourceSubscriptionId,
    });
    this.startCleanup();
  }

  resolvePendingRequest(
    requestId: string
  ): PendingRequest | undefined {
    const pending = this.pendingRequests.get(requestId);
    if (pending) {
      this.pendingRequests.delete(requestId);
    }
    return pending;
  }

  removeClientPendingRequests(ws: WebSocket): void {
    let removed = 0;
    for (const [requestId, pending] of this.pendingRequests) {
      if (pending.clientWs === ws) {
        if (pending.resourceSubscriptionId !== undefined) {
          this.removeResourceSubscription(pending.resourceSubscriptionId);
        }
        this.pendingRequests.delete(requestId);
        removed++;
      }
    }
    if (removed > 0) {
      logger.debug({ removed }, "cleaned up pending requests for disconnected client");
    }
  }

  removeClientResourceSubscriptions(ws: WebSocket): void {
    let removed = 0;
    for (const [subscriptionId, subscription] of this.resourceSubscriptions) {
      if (subscription.clientWs === ws) {
        this.resourceSubscriptions.delete(subscriptionId);
        removed++;
      }
    }
    if (removed > 0) {
      logger.debug(
        { removed },
        "cleaned up resource subscriptions for disconnected client"
      );
    }
  }
}

export const relayManager = new RelayManager();

// ---- Validation ----

function parseQueryParams(
  url: string | undefined
): Record<string, string> {
  if (!url) return {};
  const idx = url.indexOf("?");
  if (idx === -1) return {};
  const qs = url.slice(idx + 1);
  const params: Record<string, string> = {};
  for (const part of qs.split("&")) {
    const [key, val] = part.split("=");
    if (key) params[decodeURIComponent(key)] = decodeURIComponent(val ?? "");
  }
  return params;
}

function validateDevToken(params: Record<string, string>): boolean {
  const token = params.devToken;
  if (!token || token !== config.relayDevToken) {
    return false;
  }
  return true;
}

function validateEnvelope(
  data: unknown
): RemoteEnvelopeV1Request | RemoteEnvelopeV1Response | RemoteEnvelopeV1Event | RemoteEnvelopeV1Heartbeat | null {
  if (typeof data !== "object" || data === null) return null;
  const obj = data as Record<string, unknown>;

  // B2 originally used "1.0.0"; Phase 6-A/remote-web/bridge use canonical v1.
  if (obj.schemaVersion !== SCHEMA_VERSION && obj.schemaVersion !== 1) return null;

  // type required
  if (typeof obj.type !== "string") return null;

  // Check for blocked message types
  if (
    BLOCKED_MESSAGE_TYPES.includes(
      obj.type as (typeof BLOCKED_MESSAGE_TYPES)[number]
    )
  ) {
    return null;
  }

  return data as
    | RemoteEnvelopeV1Request
    | RemoteEnvelopeV1Response
    | RemoteEnvelopeV1Event
    | RemoteEnvelopeV1Heartbeat;
}

function isCanonicalEnvelope(envelope: unknown): boolean {
  return (
    typeof envelope === "object" &&
    envelope !== null &&
    (envelope as RelayEnvelope).schemaVersion === 1 &&
    typeof (envelope as RelayEnvelope).kind === "string"
  );
}

function isHeartbeatEnvelope(envelope: RelayEnvelope): boolean {
  return (
    envelope.type === "heartbeat.ping" ||
    envelope.type === "heartbeat.pong" ||
    envelope.kind === "heartbeat"
  );
}

function isBridgeResponseEnvelope(envelope: RelayEnvelope): boolean {
  return (
    typeof envelope.requestId === "string" &&
    (envelope.ok !== undefined ||
      envelope.kind === "response" ||
      envelope.kind === "error")
  );
}

function getCanonicalPayloadRecord(envelope: RelayEnvelope): Record<string, unknown> {
  const payload = envelope.payload;
  return typeof payload === "object" && payload !== null
    ? (payload as Record<string, unknown>)
    : {};
}

function getResourceSequence(envelope: RelayEnvelope): number | undefined {
  const payload = getCanonicalPayloadRecord(envelope);
  const sequence = payload.sequence;
  return typeof sequence === "number" ? sequence : undefined;
}

function getResourceEventId(envelope: RelayEnvelope): string | undefined {
  const payload = getCanonicalPayloadRecord(envelope);
  const eventId = payload.eventId;
  return typeof eventId === "string" ? eventId : undefined;
}

function getAfterSequence(envelope: RelayEnvelope): number {
  const payload = getCanonicalPayloadRecord(envelope);
  const afterSequence = payload.afterSequence;
  return typeof afterSequence === "number" && Number.isFinite(afterSequence)
    ? Math.max(0, Math.floor(afterSequence))
    : 0;
}

function resourceSubscribeResponseSubscriptionId(
  envelope: RelayEnvelope
): string | undefined {
  const payload = getCanonicalPayloadRecord(envelope);
  const data = payload.data;
  if (typeof data !== "object" || data === null) {
    return undefined;
  }
  const subscriptionId = (data as Record<string, unknown>).subscriptionId;
  return typeof subscriptionId === "string" ? subscriptionId : undefined;
}

function sendHeartbeatPong(ws: WebSocket, envelope: RelayEnvelope): void {
  if (isCanonicalEnvelope(envelope)) {
    const payload = envelope.payload as { now?: string } | undefined;
    ws.send(
      JSON.stringify({
        schemaVersion: 1,
        envelopeId: randomUUID(),
        kind: "heartbeat",
        type: "heartbeat.pong",
        sentAt: new Date().toISOString(),
        actor: { role: "relay" },
        payload: {
          now: new Date().toISOString(),
          ...(payload?.now ? { receivedAt: payload.now } : {}),
        },
      })
    );
    return;
  }

  ws.send(
    JSON.stringify({
      schemaVersion: SCHEMA_VERSION,
      type: "heartbeat.pong",
      timestamp: new Date().toISOString(),
    })
  );
}

function sendDeviceRegisterResponse(
  ws: WebSocket,
  envelope: RelayEnvelope,
  deviceId: string,
  userId: string
): void {
  if (typeof envelope.requestId !== "string") return;

  if (isCanonicalEnvelope(envelope)) {
    ws.send(
      JSON.stringify({
        schemaVersion: 1,
        envelopeId: randomUUID(),
        kind: "response",
        type: "device.register",
        sentAt: new Date().toISOString(),
        actor: { role: "relay", userId, deviceId },
        requestId: envelope.requestId,
        payload: {
          ok: true,
          data: { deviceId, status: "online" },
        },
      })
    );
    return;
  }

  ws.send(
    JSON.stringify({
      schemaVersion: SCHEMA_VERSION,
      requestId: envelope.requestId,
      sessionId: String(envelope.sessionId ?? ""),
      type: "device.register",
      ok: true,
      payload: { deviceId, status: "online" },
      timestamp: new Date().toISOString(),
    })
  );
}

function sendRelayError(
  ws: WebSocket,
  envelope: RelayEnvelope,
  code: string,
  message: string,
  retriable = false
): void {
  const requestId =
    typeof envelope.requestId === "string" ? envelope.requestId : "unknown";
  const type = typeof envelope.type === "string" ? envelope.type : "unknown";

  if (isCanonicalEnvelope(envelope)) {
    ws.send(
      JSON.stringify({
        schemaVersion: 1,
        envelopeId: randomUUID(),
        kind: "error",
        type,
        sentAt: new Date().toISOString(),
        actor: { role: "relay" },
        requestId,
        target: envelope.target,
        payload: {
          ok: false,
          error: { code, message, retriable },
        },
      })
    );
    return;
  }

  ws.send(
    JSON.stringify({
      schemaVersion: SCHEMA_VERSION,
      requestId,
      sessionId: String(envelope.sessionId ?? ""),
      type,
      ok: false,
      payload: {},
      error: { code, message },
      timestamp: new Date().toISOString(),
    })
  );
}

// ---- Connection Handler ----

export function handleBridgeConnection(
  ws: WebSocket,
  req: IncomingMessage
): void {
  const params = parseQueryParams(req.url);
  const connId =
    Math.random().toString(36).slice(2, 8);
  const auth = resolveAuth(req);

  // Redact token for logging
  const logParams = { ...params, devToken: params.devToken ? "[REDACTED]" : undefined };
  logger.info({ connId, direction: "bridge", authType: auth.type, params: logParams }, "bridge connection attempt");

  let deviceId: string;
  let userId: string;

  // Product path: Bearer deviceToken
  if (auth.type === "bearer" && auth.token) {
    try {
      const decoded = verifyDeviceToken(auth.token);
      deviceId = decoded.deviceId;
      userId = decoded.userId;
    } catch (err: any) {
      logger.warn({ connId, err: err.message }, "bridge rejected - invalid device token");
      ws.close(4001, "invalid device token");
      return;
    }

    // Check device exists and not revoked（已硬删除的行同样拒绝，让 bridge 走重注册自愈）
    const device = deviceModel.findById(deviceId);
    if (!device) {
      logger.warn({ connId, deviceId }, "bridge rejected - device not found");
      ws.close(4003, "device not found");
      return;
    }
    if (device.revoked_at) {
      logger.warn({ connId, deviceId }, "bridge rejected - device revoked");
      ws.close(4003, "device revoked");
      return;
    }
  }
  // Dev-mode fallback: query param devToken (only in test/dev with explicit allow)
  else if (config.allowDevToken && validateDevToken(params)) {
    deviceId = params.deviceId;
    userId = params.userId;
    if (!deviceId || !userId) {
      logger.warn({ connId }, "bridge rejected - missing deviceId or userId");
      ws.close(4002, "missing deviceId or userId");
      return;
    }
  }
  else {
    logger.warn({ connId }, "bridge rejected - no valid auth");
    ws.close(4001, "invalid auth");
    return;
  }

  relayManager.addBridge(deviceId, userId, ws);

  // Mark device online
  try { deviceModel.setStatus(deviceId, "online"); } catch {}

  ws.on("message", (raw) => {
    let data: unknown;
    try {
      data = JSON.parse(raw.toString());
    } catch {
      logger.warn({ connId, deviceId }, "bridge sent invalid JSON");
      return;
    }

    const envelope = validateEnvelope(data);
    if (!envelope) {
      logger.warn(
        { connId, deviceId, type: (data as Record<string, unknown>)?.type },
        "bridge sent invalid envelope"
      );
      return;
    }

    const envelopeRecord = envelope as unknown as RelayEnvelope;
    relayManager.updateBridgeHeartbeat(deviceId);

    // Handle heartbeat
    if (isHeartbeatEnvelope(envelopeRecord)) {
      sendHeartbeatPong(ws, envelopeRecord);
      logger.debug({ connId, deviceId }, "heartbeat pong");
      return;
    }

    if (envelope.type === "device.register") {
      sendDeviceRegisterResponse(ws, envelopeRecord, deviceId, userId);
      return;
    }

    // Handle events.forward - route to subscribed clients
    if (envelope.type === "events.forward") {
      const deviceClients = relayManager.getClientsForDevice(deviceId);
      const isCanonical = isCanonicalEnvelope(envelopeRecord);
      const eventId = isCanonical
        ? (envelopeRecord.payload as Record<string, unknown>)?.event &&
          ((envelopeRecord.payload as Record<string, unknown>).event as Record<string, unknown>)?.eventId
        : (envelope as RemoteEnvelopeV1Event).eventId;
      const sequence = isCanonical
        ? (envelopeRecord.payload as Record<string, unknown>)?.event &&
          ((envelopeRecord.payload as Record<string, unknown>).event as Record<string, unknown>)?.sequence
        : (envelope as RemoteEnvelopeV1Event).sequence;
      logger.debug(
        {
          connId,
          deviceId,
          eventId,
          sequence,
          clientCount: deviceClients.length,
        },
        "forwarding event to clients"
      );
      for (const client of deviceClients) {
        if (client.ws.readyState === WebSocket.OPEN) {
          relayManager.routeToClientByWs(client.ws, envelopeRecord);
        }
      }
      return;
    }

    // Handle resources.changed - route resource invalidation events only to
    // clients that explicitly subscribed to this device.
    if (envelope.type === "resources.changed") {
      const subscribers = relayManager.getResourceSubscribersForDevice(deviceId);
      const eventId = getResourceEventId(envelopeRecord);
      const sequence = getResourceSequence(envelopeRecord);
      logger.debug(
        {
          connId,
          deviceId,
          eventId,
          sequence,
          subscriberCount: subscribers.length,
        },
        "forwarding resource event to subscribed clients"
      );
      for (const subscriber of subscribers) {
        relayManager.routeToClientByWs(subscriber.clientWs, envelopeRecord);
      }
      return;
    }

    // Handle responses from bridge (back to client)
    // Bridge responses have a requestId that maps back to the original client
    if (isBridgeResponseEnvelope(envelopeRecord)) {
      const requestId = typeof envelopeRecord.requestId === "string"
        ? envelopeRecord.requestId
        : "unknown";
      const responseType = typeof envelopeRecord.type === "string"
        ? envelopeRecord.type
        : "unknown";
      const pending = relayManager.resolvePendingRequest(requestId);
      if (pending && pending.clientWs.readyState === WebSocket.OPEN) {
        if (responseType === "resources.subscribe") {
          const subscriptionId =
            resourceSubscribeResponseSubscriptionId(envelopeRecord);
          if (pending.resourceSubscriptionId !== undefined) {
            relayManager.removeResourceSubscription(pending.resourceSubscriptionId);
          }
          if (subscriptionId !== undefined) {
            relayManager.addResourceSubscription({
              subscriptionId,
              client: {
                clientId: pending.clientId,
                userId: pending.userId,
                targetDeviceId: pending.deviceId,
                ws: pending.clientWs,
                connectedAt: Date.now(),
              },
              afterSequence: 0,
            });
          }
        }
        relayManager.routeToClientByWs(pending.clientWs, envelopeRecord);
        logger.debug(
          { connId, deviceId, requestId, type: responseType, clientId: pending.clientId },
          "response routed to original client"
        );
      } else if (!pending) {
        logger.warn(
          { connId, deviceId, requestId, type: responseType },
          "no pending request for bridge response - dropping"
        );
      }
      return;
    }

    logger.warn(
      { connId, deviceId, type: envelope.type },
      "unhandled bridge message"
    );
  });

  ws.on("close", (code, reason) => {
    logger.info(
      { connId, deviceId, code, reason: reason?.toString() },
      "bridge connection closed"
    );
    relayManager.removeBridge(deviceId);
    try { deviceModel.setStatus(deviceId, "offline"); } catch {}
  });

  ws.on("error", (err) => {
    logger.error(
      { connId, deviceId, error: err.message },
      "bridge connection error"
    );
  });
}

export function handleClientConnection(
  ws: WebSocket,
  req: IncomingMessage
): void {
  const params = parseQueryParams(req.url);
  const connId =
    Math.random().toString(36).slice(2, 8);
  const auth = resolveAuth(req);

  const logParams = { ...params, devToken: params.devToken ? "[REDACTED]" : undefined };
  logger.info({ connId, direction: "client", authType: auth.type, params: logParams }, "client connection attempt");

  let clientId: string;
  let userId: string;
  let targetDeviceId: string;

  // Product path: Bearer accessToken
  if (auth.type === "bearer" && auth.token) {
    try {
      const decoded = verifyAccessToken(auth.token);
      userId = decoded.userId;
    } catch (err: any) {
      logger.warn({ connId, err: err.message }, "client rejected - invalid access token");
      ws.close(4001, "invalid access token");
      return;
    }

    clientId = params.clientId || `client-${connId}`;
    targetDeviceId = params.targetDeviceId || "";

    if (!targetDeviceId) {
      logger.warn({ connId }, "client rejected - missing targetDeviceId");
      ws.close(4002, "missing targetDeviceId");
      return;
    }
  }
  // Dev-mode fallback: query param devToken (only in test/dev with explicit allow)
  else if (config.allowDevToken && validateDevToken(params)) {
    clientId = params.clientId;
    userId = params.userId;
    targetDeviceId = params.targetDeviceId;

    if (!clientId || !userId || !targetDeviceId) {
      logger.warn({ connId }, "client rejected - missing clientId, userId, or targetDeviceId");
      ws.close(4002, "missing clientId, userId, or targetDeviceId");
      return;
    }
  }
  else {
    logger.warn({ connId }, "client rejected - no valid auth");
    ws.close(4001, "invalid auth");
    return;
  }

  relayManager.addClient(clientId, userId, targetDeviceId, ws);

  // Send connection confirmation
  const bridgeOnline = relayManager.isBridgeOnline(targetDeviceId);
  ws.send(
    JSON.stringify({
      schemaVersion: SCHEMA_VERSION,
      type: "device.status",
      ok: true,
      payload: {
        deviceId: targetDeviceId,
        online: bridgeOnline,
      },
      timestamp: new Date().toISOString(),
    })
  );

  ws.on("message", (raw) => {
    let data: unknown;
    try {
      data = JSON.parse(raw.toString());
    } catch {
      logger.warn({ connId, clientId }, "client sent invalid JSON");
      return;
    }

    const envelope = validateEnvelope(data);
    if (!envelope) {
      const type = (data as Record<string, unknown>)?.type;
      logger.warn(
        { connId, clientId, type },
        "client sent invalid or blocked envelope"
      );
      // If the message is blocked, send an error back
      if (
        typeof type === "string" &&
        BLOCKED_MESSAGE_TYPES.includes(type as (typeof BLOCKED_MESSAGE_TYPES)[number])
      ) {
        ws.send(
          JSON.stringify(
            isCanonicalEnvelope(data)
              ? {
                  schemaVersion: 1,
                  envelopeId: randomUUID(),
                  kind: "error",
                  type,
                  sentAt: new Date().toISOString(),
                  actor: { role: "relay" },
                  requestId:
                    typeof (data as RelayEnvelope).requestId === "string"
                      ? (data as RelayEnvelope).requestId
                      : "unknown",
                  target: (data as RelayEnvelope).target,
                  payload: {
                    ok: false,
                    error: {
                      code: "BLOCKED",
                      message: `Message type '${type}' is not allowed`,
                      retriable: false,
                    },
                  },
                }
              : {
                  schemaVersion: SCHEMA_VERSION,
                  requestId: (data as Record<string, unknown>)?.requestId ?? "unknown",
                  sessionId: (data as Record<string, unknown>)?.sessionId ?? "",
                  type,
                  ok: false,
                  payload: {},
                  error: { code: "BLOCKED", message: `Message type '${type}' is not allowed` },
                  timestamp: new Date().toISOString(),
                }
          )
        );
      }
      return;
    }

    const envelopeRecord = envelope as unknown as RelayEnvelope;

    // Handle heartbeat
    if (isHeartbeatEnvelope(envelopeRecord)) {
      sendHeartbeatPong(ws, envelopeRecord);
      return;
    }

    // Handle requests from client -> route to bridge
    if ("requestId" in envelope) {
      // Validate requestId presence
      if (!envelope.requestId) {
        sendRelayError(ws, envelopeRecord, "MISSING_REQUEST_ID", "requestId is required");
        return;
      }

      const client = relayManager.findClientByWs(ws);
      if (!client) return;

      if (envelope.type === "resources.unsubscribe") {
        const payload = getCanonicalPayloadRecord(envelopeRecord);
        const subscriptionId = payload.subscriptionId;
        if (typeof subscriptionId === "string") {
          relayManager.removeResourceSubscription(subscriptionId);
        }
      }

      // Ownership check: only for Bearer-authenticated (production) clients
      // Dev-token clients skip this check (they are test/dev only)
      if (auth.type === "bearer") {
        const targetDevice = deviceModel.findById(client.targetDeviceId);
        if (!targetDevice || targetDevice.user_id !== client.userId) {
          sendRelayError(
            ws,
            envelopeRecord,
            "FORBIDDEN",
            "You do not own this device",
            false
          );
          return;
        }
        if (targetDevice.revoked_at) {
          sendRelayError(
            ws,
            envelopeRecord,
            "FORBIDDEN",
            "Device has been revoked",
            false
          );
          return;
        }
      }

      const routed = relayManager.routeRequestToBridge(client, envelopeRecord);
      if (!routed) {
        sendRelayError(
          ws,
          envelopeRecord,
          "DEVICE_OFFLINE",
          `Device '${client.targetDeviceId}' is not connected`,
          true
        );
      }
      return;
    }

    logger.warn(
      { connId, clientId, type: envelope.type },
      "unhandled client message"
    );
  });

  ws.on("close", (code, reason) => {
    logger.info(
      { connId, clientId, code, reason: reason?.toString() },
      "client connection closed"
    );
    relayManager.removeClient(ws);
  });

  ws.on("error", (err) => {
    logger.error(
      { connId, clientId, error: err.message },
      "client connection error"
    );
  });
}
