import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { createWsTestApp, connectWs } from "./helpers/ws-setup.js";
import type { WsTestContext } from "./helpers/ws-setup.js";

const DEV_TOKEN = "test-dev-token-fixed-for-test-suite";

function now() {
  return new Date().toISOString();
}

function makeCanonicalHeartbeat() {
  return {
    schemaVersion: 1 as const,
    envelopeId: `env-${Math.random().toString(36).slice(2, 10)}`,
    kind: "heartbeat" as const,
    type: "heartbeat.ping",
    sentAt: now(),
    actor: { deviceId: "desktop-dev-1", userId: "dev-user" },
    payload: { now: now() },
  };
}

function makeCanonicalRequest(overrides: Record<string, unknown> = {}) {
  return {
    schemaVersion: 1 as const,
    envelopeId: `env-${Math.random().toString(36).slice(2, 10)}`,
    kind: "request" as const,
    requestId: `req-${Math.random().toString(36).slice(2, 10)}`,
    type: "local.health.get",
    sentAt: now(),
    actor: { clientId: "web-dev-1", userId: "dev-user" },
    target: { deviceId: "desktop-dev-1" },
    payload: {},
    ...overrides,
  };
}

function makeCanonicalEvent(overrides: Record<string, unknown> = {}) {
  return {
    schemaVersion: 1 as const,
    envelopeId: `env-${Math.random().toString(36).slice(2, 10)}`,
    kind: "event" as const,
    type: "events.forward",
    sentAt: now(),
    actor: { deviceId: "desktop-dev-1" },
    payload: {
      subscriptionId: "sub-1",
      event: {
        schemaVersion: "1.0.0",
        eventId: `evt-${Math.random().toString(36).slice(2, 10)}`,
        sequence: 1,
        sessionId: "test-session",
        type: "assistant.text",
        timestamp: now(),
        payload: { text: "hello" },
      },
    },
    ...overrides,
  };
}

describe("Phase 6-C: Canonical Protocol", () => {
  let ctx: WsTestContext;

  beforeEach(async () => {
    ctx = await createWsTestApp();
  });

  afterEach(async () => {
    await ctx.close();
  });

  // ---- Canonical bridge connection ----

  describe("Canonical bridge", () => {
    it("connects and receives canonical heartbeat pong", async () => {
      const bridge = await connectWs(
        ctx,
        `/ws/bridge?deviceId=desktop-dev-1&userId=dev-user&devToken=${DEV_TOKEN}`
      );

      bridge.ws.send(JSON.stringify(makeCanonicalHeartbeat()));

      const msg = await bridge.waitForMessage();
      const data = msg as Record<string, unknown>;
      expect(data.schemaVersion).toBe(1);
      expect(data.kind).toBe("heartbeat");
      expect(data.type).toBe("heartbeat.pong");

      bridge.ws.close();
    });

    it("device.register is accepted with canonical response", async () => {
      const bridge = await connectWs(
        ctx,
        `/ws/bridge?deviceId=desktop-dev-1&userId=dev-user&devToken=${DEV_TOKEN}`
      );

      const regReq = makeCanonicalRequest({
        requestId: "reg-1",
        type: "device.register",
        actor: { deviceId: "desktop-dev-1", userId: "dev-user" },
        payload: {},
      });

      bridge.ws.send(JSON.stringify(regReq));

      const msg = await bridge.waitForMessage();
      const data = msg as Record<string, unknown>;
      expect(data.schemaVersion).toBe(1);
      expect(data.kind).toBe("response");
      expect(data.type).toBe("device.register");
      expect(data.requestId).toBe("reg-1");
      expect((data.payload as Record<string, unknown>).ok).toBe(true);
      expect(
        ((data.payload as Record<string, unknown>).data as Record<string, unknown>)
          ?.deviceId
      ).toBe("desktop-dev-1");

      bridge.ws.close();
    });
  });

  // ---- Canonical client request routing ----

  describe("Canonical request routing", () => {
    it("routes canonical client request to bridge and returns canonical response", async () => {
      const bridge = await connectWs(
        ctx,
        `/ws/bridge?deviceId=desktop-dev-1&userId=dev-user&devToken=${DEV_TOKEN}`
      );

      const client = await connectWs(
        ctx,
        `/ws/client?clientId=web-dev-1&userId=dev-user&targetDeviceId=desktop-dev-1&devToken=${DEV_TOKEN}`
      );

      // Wait for legacy device.status (client connected in legacy mode)
      await client.waitForMessage();

      const requestId = "canonical-req-1";
      const canonicalReq = makeCanonicalRequest({ requestId });
      client.ws.send(JSON.stringify(canonicalReq));

      // Bridge receives the canonical request unchanged
      const bridgeMsg = await bridge.waitForMessage();
      const bData = bridgeMsg as Record<string, unknown>;
      expect(bData.schemaVersion).toBe(1);
      expect(bData.kind).toBe("request");
      expect(bData.requestId).toBe(requestId);
      expect(bData.type).toBe("local.health.get");

      // Bridge sends canonical response
      bridge.ws.send(
        JSON.stringify({
          schemaVersion: 1,
          envelopeId: `env-resp-${Math.random().toString(36).slice(2, 8)}`,
          kind: "response",
          type: "local.health.get",
          sentAt: now(),
          actor: { deviceId: "desktop-dev-1" },
          requestId,
          payload: {
            ok: true,
            data: { status: "ok" },
          },
        })
      );

      // Client receives the canonical response
      const clientMsg = await client.waitForMessage();
      const cData = clientMsg as Record<string, unknown>;
      expect(cData.schemaVersion).toBe(1);
      expect(cData.kind).toBe("response");
      expect(cData.requestId).toBe(requestId);
      expect((cData.payload as Record<string, unknown>).ok).toBe(true);

      bridge.ws.close();
      client.ws.close();
    });

    it("returns canonical DEVICE_OFFLINE error when bridge not connected", async () => {
      // Client connects without bridge
      const client = await connectWs(
        ctx,
        `/ws/client?clientId=web-dev-1&userId=dev-user&targetDeviceId=desktop-dev-1&devToken=${DEV_TOKEN}`
      );

      await client.waitForMessage();

      const canonicalReq = makeCanonicalRequest({
        requestId: "offline-canonical",
        type: "sessions.list",
      });
      client.ws.send(JSON.stringify(canonicalReq));

      const msg = await client.waitForMessage();
      const data = msg as Record<string, unknown>;
      // Error format matches request format (canonical)
      expect(data.kind).toBe("error");
      expect(data.schemaVersion).toBe(1);
      expect((data.payload as Record<string, unknown>).ok).toBe(false);
      expect(
        ((data.payload as Record<string, unknown>).error as Record<string, unknown>)?.code
      ).toBe("DEVICE_OFFLINE");

      client.ws.close();
    });
  });

  // ---- Canonical targeted response ----

  describe("Canonical targeted response", () => {
    it("only requesting canonical client receives response", async () => {
      const bridge = await connectWs(
        ctx,
        `/ws/bridge?deviceId=desktop-dev-1&userId=dev-user&devToken=${DEV_TOKEN}`
      );

      const clientA = await connectWs(
        ctx,
        `/ws/client?clientId=web-dev-a&userId=dev-user&targetDeviceId=desktop-dev-1&devToken=${DEV_TOKEN}`
      );
      await clientA.waitForMessage();

      const clientB = await connectWs(
        ctx,
        `/ws/client?clientId=web-dev-b&userId=dev-user&targetDeviceId=desktop-dev-1&devToken=${DEV_TOKEN}`
      );
      await clientB.waitForMessage();
      clientA.drainMessages();
      clientB.drainMessages();

      const requestId = "canonical-targeted-1";
      clientA.ws.send(JSON.stringify(makeCanonicalRequest({ requestId })));

      // Bridge receives and responds
      const bridgeMsg = await bridge.waitForMessage();
      expect((bridgeMsg as Record<string, unknown>).requestId).toBe(requestId);

      bridge.ws.send(
        JSON.stringify({
          schemaVersion: 1,
          envelopeId: `env-${Math.random().toString(36).slice(2, 8)}`,
          kind: "response",
          type: "local.health.get",
          sentAt: now(),
          requestId,
          actor: { deviceId: "desktop-dev-1" },
          payload: { ok: true, data: { status: "ok" } },
        })
      );

      // Client A gets response
      const msgA = await clientA.waitForMessage();
      expect((msgA as Record<string, unknown>).requestId).toBe(requestId);

      // Client B gets nothing
      expect(clientB.messages.length).toBe(0);

      bridge.ws.close();
      clientA.ws.close();
      clientB.ws.close();
    });
  });

  // ---- Canonical events.forward ----

  describe("Canonical events.forward", () => {
    it("forwards canonical event from bridge to subscribed client", async () => {
      const bridge = await connectWs(
        ctx,
        `/ws/bridge?deviceId=desktop-dev-1&userId=dev-user&devToken=${DEV_TOKEN}`
      );

      const client = await connectWs(
        ctx,
        `/ws/client?clientId=web-dev-1&userId=dev-user&targetDeviceId=desktop-dev-1&devToken=${DEV_TOKEN}`
      );
      await client.waitForMessage();

      const eventId = "canonical-evt-1";
      const sequence = 7;
      const evt = makeCanonicalEvent();
      // Set nested fields at the right level
      (evt.payload.event as Record<string, unknown>).eventId = eventId;
      (evt.payload.event as Record<string, unknown>).sequence = sequence;
      bridge.ws.send(JSON.stringify(evt));

      const msg = await client.waitForMessage();
      const data = msg as Record<string, unknown>;
      expect(data.schemaVersion).toBe(1);
      expect(data.kind).toBe("event");
      expect(data.type).toBe("events.forward");

      // Event content preserved
      const payload = data.payload as Record<string, unknown>;
      const innerEvent = payload.event as Record<string, unknown>;
      expect(innerEvent.eventId).toBe(eventId);
      expect(innerEvent.sequence).toBe(sequence);

      bridge.ws.close();
      client.ws.close();
    });
  });

  // ---- Canonical resource sync ----

  describe("Canonical resources.changed", () => {
    it("delivers replay resources.changed emitted before subscribe response", async () => {
      const bridge = await connectWs(
        ctx,
        `/ws/bridge?deviceId=desktop-dev-1&userId=dev-user&devToken=${DEV_TOKEN}`
      );

      const client = await connectWs(
        ctx,
        `/ws/client?clientId=web-dev-1&userId=dev-user&targetDeviceId=desktop-dev-1&devToken=${DEV_TOKEN}`
      );
      await client.waitForMessage();

      const requestId = "resources-subscribe-replay-1";
      client.ws.send(
        JSON.stringify(
          makeCanonicalRequest({
            requestId,
            type: "resources.subscribe",
            payload: { afterSequence: 0 },
          })
        )
      );

      const subscribeRequest = await bridge.waitForMessage();
      expect((subscribeRequest as Record<string, unknown>).type).toBe(
        "resources.subscribe"
      );
      expect((subscribeRequest as Record<string, unknown>).requestId).toBe(
        requestId
      );

      bridge.ws.send(
        JSON.stringify({
          schemaVersion: 1,
          envelopeId: "resource-event-replay-env",
          kind: "event",
          type: "resources.changed",
          sentAt: now(),
          actor: { role: "bridge", deviceId: "desktop-dev-1" },
          target: { deviceId: "desktop-dev-1", projectId: "project-1", sessionId: "session-1" },
          payload: {
            schemaVersion: 1,
            eventId: "resource-event-replay-1",
            deviceId: "desktop-dev-1",
            sequence: 1,
            type: "session.created",
            resource: { kind: "session", id: "session-1", projectId: "project-1" },
            origin: { source: "remote-web", clientId: "web-dev-1", requestId },
            timestamp: now(),
          },
        })
      );

      const replay = await client.waitForMessage();
      expect((replay as Record<string, unknown>).type).toBe("resources.changed");
      expect(((replay as Record<string, unknown>).payload as Record<string, unknown>).eventId).toBe(
        "resource-event-replay-1"
      );

      bridge.ws.send(
        JSON.stringify({
          schemaVersion: 1,
          envelopeId: "resource-subscribe-response-env",
          kind: "response",
          type: "resources.subscribe",
          sentAt: now(),
          actor: { role: "bridge", deviceId: "desktop-dev-1" },
          requestId,
          payload: {
            ok: true,
            data: {
              subscriptionId: "resource-sub-1",
              deviceId: "desktop-dev-1",
              currentSequence: 1,
              replaySupported: true,
            },
          },
        })
      );

      const response = await client.waitForMessage();
      expect((response as Record<string, unknown>).kind).toBe("response");
      expect((response as Record<string, unknown>).requestId).toBe(requestId);

      bridge.ws.close();
      client.ws.close();
    });

    it("fans out resources.changed only to subscribed clients", async () => {
      const bridge = await connectWs(
        ctx,
        `/ws/bridge?deviceId=desktop-dev-1&userId=dev-user&devToken=${DEV_TOKEN}`
      );

      const clientA = await connectWs(
        ctx,
        `/ws/client?clientId=web-dev-a&userId=dev-user&targetDeviceId=desktop-dev-1&devToken=${DEV_TOKEN}`
      );
      await clientA.waitForMessage();

      const clientB = await connectWs(
        ctx,
        `/ws/client?clientId=web-dev-b&userId=dev-user&targetDeviceId=desktop-dev-1&devToken=${DEV_TOKEN}`
      );
      await clientB.waitForMessage();

      const requestId = "resources-subscribe-a";
      clientA.ws.send(
        JSON.stringify(
          makeCanonicalRequest({
            requestId,
            type: "resources.subscribe",
            payload: { afterSequence: 0 },
          })
        )
      );
      await bridge.waitForMessage();
      bridge.ws.send(
        JSON.stringify({
          schemaVersion: 1,
          envelopeId: "resource-sub-a-response",
          kind: "response",
          type: "resources.subscribe",
          sentAt: now(),
          actor: { role: "bridge", deviceId: "desktop-dev-1" },
          requestId,
          payload: {
            ok: true,
            data: {
              subscriptionId: "resource-sub-a",
              deviceId: "desktop-dev-1",
              currentSequence: 0,
              replaySupported: true,
            },
          },
        })
      );
      await clientA.waitForMessage();
      clientA.drainMessages();
      clientB.drainMessages();

      bridge.ws.send(
        JSON.stringify({
          schemaVersion: 1,
          envelopeId: "resource-event-live-env",
          kind: "event",
          type: "resources.changed",
          sentAt: now(),
          actor: { role: "bridge", deviceId: "desktop-dev-1" },
          target: { deviceId: "desktop-dev-1", projectId: "project-1", sessionId: "session-2" },
          payload: {
            schemaVersion: 1,
            eventId: "resource-event-live-1",
            deviceId: "desktop-dev-1",
            sequence: 2,
            type: "session.created",
            resource: { kind: "session", id: "session-2", projectId: "project-1" },
            origin: { source: "android", clientId: "mobile-dev-1" },
            timestamp: now(),
          },
        })
      );

      const eventA = await clientA.waitForMessage();
      expect((eventA as Record<string, unknown>).type).toBe("resources.changed");
      expect(clientB.messages.length).toBe(0);

      bridge.ws.close();
      clientA.ws.close();
      clientB.ws.close();
    });

    it("stops resources.changed fanout after resources.unsubscribe", async () => {
      const bridge = await connectWs(
        ctx,
        `/ws/bridge?deviceId=desktop-dev-1&userId=dev-user&devToken=${DEV_TOKEN}`
      );
      const client = await connectWs(
        ctx,
        `/ws/client?clientId=web-dev-1&userId=dev-user&targetDeviceId=desktop-dev-1&devToken=${DEV_TOKEN}`
      );
      await client.waitForMessage();

      const subscribeRequestId = "resources-subscribe-unsub";
      client.ws.send(
        JSON.stringify(
          makeCanonicalRequest({
            requestId: subscribeRequestId,
            type: "resources.subscribe",
            payload: { afterSequence: 0 },
          })
        )
      );
      await bridge.waitForMessage();
      bridge.ws.send(
        JSON.stringify({
          schemaVersion: 1,
          envelopeId: "resource-sub-unsub-response",
          kind: "response",
          type: "resources.subscribe",
          sentAt: now(),
          actor: { role: "bridge", deviceId: "desktop-dev-1" },
          requestId: subscribeRequestId,
          payload: {
            ok: true,
            data: {
              subscriptionId: "resource-sub-unsub",
              deviceId: "desktop-dev-1",
              currentSequence: 0,
              replaySupported: true,
            },
          },
        })
      );
      await client.waitForMessage();

      const unsubscribeRequestId = "resources-unsubscribe-1";
      client.ws.send(
        JSON.stringify(
          makeCanonicalRequest({
            requestId: unsubscribeRequestId,
            type: "resources.unsubscribe",
            payload: { subscriptionId: "resource-sub-unsub" },
          })
        )
      );
      const unsubscribeBridgeRequest = await bridge.waitForMessage();
      expect((unsubscribeBridgeRequest as Record<string, unknown>).type).toBe(
        "resources.unsubscribe"
      );
      bridge.ws.send(
        JSON.stringify({
          schemaVersion: 1,
          envelopeId: "resource-unsub-response",
          kind: "response",
          type: "resources.unsubscribe",
          sentAt: now(),
          actor: { role: "bridge", deviceId: "desktop-dev-1" },
          requestId: unsubscribeRequestId,
          payload: { ok: true, data: { subscriptionId: "resource-sub-unsub", closed: true } },
        })
      );
      await client.waitForMessage();
      client.drainMessages();

      bridge.ws.send(
        JSON.stringify({
          schemaVersion: 1,
          envelopeId: "resource-event-after-unsub",
          kind: "event",
          type: "resources.changed",
          sentAt: now(),
          actor: { role: "bridge", deviceId: "desktop-dev-1" },
          target: { deviceId: "desktop-dev-1", projectId: "project-1", sessionId: "session-3" },
          payload: {
            schemaVersion: 1,
            eventId: "resource-event-after-unsub",
            deviceId: "desktop-dev-1",
            sequence: 3,
            type: "session.created",
            resource: { kind: "session", id: "session-3", projectId: "project-1" },
            origin: { source: "remote-web" },
            timestamp: now(),
          },
        })
      );

      await new Promise((resolve) => setTimeout(resolve, 200));
      expect(client.messages.length).toBe(0);

      bridge.ws.close();
      client.ws.close();
    });
  });

  // ---- Canonical blocked messages (table-driven) ----

  describe("Canonical blocked messages", () => {
    const BLOCKED_TYPES = [
      "sessions.profile.replace",
      "provider.profile.create",
      "provider.profile.edit",
      "provider.profile.delete",
    ];

    for (const blockedType of BLOCKED_TYPES) {
      it(`returns canonical BLOCKED error for ${blockedType}`, async () => {
        const client = await connectWs(
          ctx,
          `/ws/client?clientId=web-dev-1&userId=dev-user&targetDeviceId=desktop-dev-1&devToken=${DEV_TOKEN}`
        );
        await client.waitForMessage();

        client.ws.send(
          JSON.stringify(
            makeCanonicalRequest({
              requestId: `blocked-${blockedType.replace(/\./g, "-")}`,
              type: blockedType,
            })
          )
        );

        const msg = await client.waitForMessage();
        const data = msg as Record<string, unknown>;
        expect(data.kind).toBe("error");
        expect(data.schemaVersion).toBe(1);
        expect((data.payload as Record<string, unknown>).ok).toBe(false);
        expect(
          ((data.payload as Record<string, unknown>).error as Record<string, unknown>)?.code
        ).toBe("BLOCKED");

        client.ws.close();
      });

      it(`${blockedType} is not forwarded to bridge`, async () => {
        const bridge = await connectWs(
          ctx,
          `/ws/bridge?deviceId=desktop-dev-1&userId=dev-user&devToken=${DEV_TOKEN}`
        );

        const client = await connectWs(
          ctx,
          `/ws/client?clientId=web-dev-1&userId=dev-user&targetDeviceId=desktop-dev-1&devToken=${DEV_TOKEN}`
        );
        await client.waitForMessage();

        client.ws.send(
          JSON.stringify(
            makeCanonicalRequest({
              requestId: `nofwd-${blockedType.replace(/\./g, "-")}`,
              type: blockedType,
            })
          )
        );

        // Client should receive BLOCKED error immediately
        const msg = await client.waitForMessage();
        expect((msg as Record<string, unknown>).kind).toBe("error");

        // Bridge should NOT have received anything
        // Give a small delay then check
        await new Promise((r) => setTimeout(r, 200));
        const drained = bridge.drainMessages();
        const forwarded = drained.filter(
          (m: any) =>
            m.type === blockedType || m.requestId?.includes("nofwd")
        );
        expect(forwarded.length).toBe(0);

        bridge.ws.close();
        client.ws.close();
      });
    }
  });
});
