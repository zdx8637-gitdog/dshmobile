// Phase 6-A / 6-B2 WebSocket protocol types (legacy)
// Phase 6-C canonical protocol types

export const SCHEMA_VERSION = "1.0.0";

// Message direction tag within the envelope
export type RemoteMessageType =
  // Device
  | "device.register"
  // Health
  | "local.health.get"
  // Projects
  | "projects.list"
  // Sessions
  | "sessions.list"
  | "sessions.get"
  | "sessions.run"
  | "sessions.interrupt"
  // Runs
  | "runs.list"
  // Conversation
  | "conversation.history"
  // Events
  | "events.history"
  | "events.subscribe"
  | "events.unsubscribe"
  | "events.forward"
  | "resources.subscribe"
  | "resources.unsubscribe"
  | "resources.changed"
  // Heartbeat
  | "heartbeat.ping"
  | "heartbeat.pong";

// Messages the relay must reject
export const BLOCKED_MESSAGE_TYPES = [
  "sessions.profile.replace",
  "provider.profile.create",
  "provider.profile.edit",
  "provider.profile.delete",
] as const;

export type BlockedMessageType = (typeof BLOCKED_MESSAGE_TYPES)[number];

// ---- Legacy B2 Envelopes ----

export interface RemoteEnvelopeV1Request {
  schemaVersion: string;
  requestId: string;
  sessionId: string;
  runId?: string;
  type: RemoteMessageType;
  payload: Record<string, unknown>;
  timestamp: string;
}

export interface RemoteEnvelopeV1Response {
  schemaVersion: string;
  requestId: string;
  sessionId: string;
  runId?: string;
  type: RemoteMessageType;
  ok: boolean;
  payload: Record<string, unknown>;
  error?: {
    code: string;
    message: string;
  };
  timestamp: string;
}

export interface RemoteEnvelopeV1Event {
  schemaVersion: string;
  eventId: string;
  sequence: number;
  sessionId: string;
  runId?: string;
  type: "events.forward";
  payload: {
    event: string;
    data: Record<string, unknown>;
  };
  timestamp: string;
}

export interface RemoteEnvelopeV1Heartbeat {
  schemaVersion: string;
  type: "heartbeat.ping" | "heartbeat.pong";
  timestamp: string;
}

// Union types for legacy
export type RemoteEnvelopeV1Inbound =
  | RemoteEnvelopeV1Request
  | RemoteEnvelopeV1Heartbeat;

export type RemoteEnvelopeV1Outbound =
  | RemoteEnvelopeV1Response
  | RemoteEnvelopeV1Event
  | RemoteEnvelopeV1Heartbeat;

// ---- Canonical Phase 6 Envelopes ----

export type CanonicalKind = "request" | "response" | "event" | "error" | "heartbeat";

export interface CanonicalActor {
  role?: "bridge" | "client" | "relay";
  userId?: string;
  clientId?: string;
  deviceId?: string;
}

export interface CanonicalTarget {
  deviceId?: string;
  clientId?: string;
  subscriptionId?: string;
  projectId?: string;
  sessionId?: string;
}

export interface CanonicalEnvelope {
  schemaVersion: 1;
  kind: CanonicalKind;
  envelopeId?: string;
  type?: string;
  sentAt: string;
  actor?: CanonicalActor;
  target?: CanonicalTarget;
  requestId?: string;
  payload?: Record<string, unknown>;
}

export interface CanonicalRequest extends CanonicalEnvelope {
  kind: "request";
  requestId: string;
  type: string;
  payload: Record<string, unknown>;
}

export interface CanonicalResponse extends CanonicalEnvelope {
  kind: "response";
  requestId: string;
  type: string;
  payload: {
    ok: boolean;
    data?: Record<string, unknown>;
    error?: CanonicalErrorBody;
  };
}

export interface CanonicalError extends CanonicalEnvelope {
  kind: "error";
  requestId: string;
  type?: string;
  payload: {
    ok: false;
    error: CanonicalErrorBody;
  };
}

export interface CanonicalErrorBody {
  code: string;
  message: string;
  retriable?: boolean;
}

export interface CanonicalEvent extends CanonicalEnvelope {
  kind: "event";
  type: "events.forward" | "resources.changed" | string;
  payload: Record<string, unknown>;
}

export interface CanonicalHeartbeat extends CanonicalEnvelope {
  kind: "heartbeat";
  type: "heartbeat.ping" | "heartbeat.pong";
  payload?: {
    now?: string;
  };
}

// Union type for any canonical envelope
export type AnyCanonicalEnvelope =
  | CanonicalRequest
  | CanonicalResponse
  | CanonicalEvent
  | CanonicalError
  | CanonicalHeartbeat;

// ---- Format Detection ----

export type EnvelopeFormat = "canonical" | "legacy" | "unknown";

export function detectEnvelopeFormat(
  data: Record<string, unknown>
): EnvelopeFormat {
  // Canonical: schemaVersion is number 1, has "kind" field
  if (
    data.schemaVersion === 1 &&
    typeof data.kind === "string"
  ) {
    return "canonical";
  }
  // Legacy: schemaVersion is string "1.0.0", has "type" field
  if (
    data.schemaVersion === SCHEMA_VERSION &&
    typeof data.type === "string"
  ) {
    return "legacy";
  }
  return "unknown";
}

// ---- Connection metadata (query params) ----

export interface BridgeConnectParams {
  deviceId: string;
  userId: string;
  devToken: string;
}

export interface ClientConnectParams {
  clientId: string;
  userId: string;
  targetDeviceId: string;
  devToken: string;
}
