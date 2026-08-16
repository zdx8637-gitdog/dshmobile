import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { createWsTestApp, connectWs } from "./helpers/ws-setup.js";
import type { WsTestContext, BufferedWs } from "./helpers/ws-setup.js";
import { SCHEMA_VERSION } from "../src/types/protocol.js";

const DEV_TOKEN = "test-dev-token-fixed-for-test-suite";

function makeRequest(overrides: Record<string, unknown> = {}) {
  return {
    schemaVersion: SCHEMA_VERSION,
    requestId: `req-${Math.random().toString(36).slice(2, 10)}`,
    sessionId: "test-session",
    type: "local.health.get",
    payload: {},
    timestamp: new Date().toISOString(),
    ...overrides,
  };
}

function makeHeartbeat() {
  return {
    schemaVersion: SCHEMA_VERSION,
    type: "heartbeat.ping" as const,
    timestamp: new Date().toISOString(),
  };
}

function makeEvent(overrides: Record<string, unknown> = {}) {
  return {
    schemaVersion: SCHEMA_VERSION,
    eventId: `evt-${Math.random().toString(36).slice(2, 10)}`,
    sequence: 1,
    sessionId: "test-session",
    type: "events.forward",
    payload: { event: "assistant.text", data: { text: "hello" } },
    timestamp: new Date().toISOString(),
    ...overrides,
  };
}

describe("Phase 6-B2: Cloud Relay WebSocket", () => {
  let ctx: WsTestContext;

  beforeEach(async () => {
    ctx = await createWsTestApp();
  });

  afterEach(async () => {
    await ctx.close();
  });

  // ---- Bridge connection tests ----

  describe("Bridge /ws/bridge", () => {
    it("connects with correct dev token", async () => {
      const { ws } = await connectWs(
        ctx,
        `/ws/bridge?deviceId=desktop-dev-1&userId=dev-user&devToken=${DEV_TOKEN}`
      );
      expect(ws.readyState).toBe(1); // OPEN
      ws.close();
    });

    it("rejects wrong dev token", async () => {
      const bw = await connectWs(
        ctx,
        `/ws/bridge?deviceId=desktop-dev-1&userId=dev-user&devToken=wrong-token`
      );
      const code = await bw.waitForClose();
      expect(code).toBe(4001);
    });

    it("rejects missing dev token", async () => {
      const bw = await connectWs(
        ctx,
        `/ws/bridge?deviceId=desktop-dev-1&userId=dev-user`
      );
      const code = await bw.waitForClose();
      expect(code).toBe(4001);
    });

    it("rejects missing deviceId", async () => {
      const bw = await connectWs(
        ctx,
        `/ws/bridge?userId=dev-user&devToken=${DEV_TOKEN}`
      );
      const code = await bw.waitForClose();
      expect(code).toBe(4002);
    });

    it("rejects missing userId", async () => {
      const bw = await connectWs(
        ctx,
        `/ws/bridge?deviceId=desktop-dev-1&devToken=${DEV_TOKEN}`
      );
      const code = await bw.waitForClose();
      expect(code).toBe(4002);
    });
  });

  // ---- Client connection tests ----

  describe("Client /ws/client", () => {
    it("connects with correct dev token", async () => {
      const { ws } = await connectWs(
        ctx,
        `/ws/client?clientId=web-dev-1&userId=dev-user&targetDeviceId=desktop-dev-1&devToken=${DEV_TOKEN}`
      );
      expect(ws.readyState).toBe(1); // OPEN
      ws.close();
    });

    it("rejects wrong dev token", async () => {
      const bw = await connectWs(
        ctx,
        `/ws/client?clientId=web-dev-1&userId=dev-user&targetDeviceId=desktop-dev-1&devToken=wrong`
      );
      const code = await bw.waitForClose();
      expect(code).toBe(4001);
    });

    it("rejects missing clientId", async () => {
      const bw = await connectWs(
        ctx,
        `/ws/client?userId=dev-user&targetDeviceId=desktop-dev-1&devToken=${DEV_TOKEN}`
      );
      const code = await bw.waitForClose();
      expect(code).toBe(4002);
    });

    it("receives device status on connect", async () => {
      const bw = await connectWs(
        ctx,
        `/ws/client?clientId=web-dev-1&userId=dev-user&targetDeviceId=desktop-dev-1&devToken=${DEV_TOKEN}`
      );
      const msg = await bw.waitForMessage();
      expect((msg as Record<string, unknown>).type).toBe("device.status");
      expect((msg as Record<string, unknown>).ok).toBe(true);
      bw.ws.close();
    });
  });

  // ---- Message routing tests ----

  describe("Request routing", () => {
    it("routes client request to bridge and returns response", async () => {
      const bridge = await connectWs(
        ctx,
        `/ws/bridge?deviceId=desktop-dev-1&userId=dev-user&devToken=${DEV_TOKEN}`
      );

      const client = await connectWs(
        ctx,
        `/ws/client?clientId=web-dev-1&userId=dev-user&targetDeviceId=desktop-dev-1&devToken=${DEV_TOKEN}`
      );

      // Wait for device status
      await client.waitForMessage();

      // Client sends request
      const requestId = "test-routing-req-1";
      client.ws.send(
        JSON.stringify(
          makeRequest({ requestId, type: "local.health.get" })
        )
      );

      // Bridge receives request
      const bridgeMsg = await bridge.waitForMessage();
      const bridgeData = bridgeMsg as Record<string, unknown>;
      expect(bridgeData.requestId).toBe(requestId);
      expect(bridgeData.type).toBe("local.health.get");

      // Bridge sends response
      const response = {
        schemaVersion: SCHEMA_VERSION,
        requestId,
        sessionId: "test-session",
        type: "local.health.get",
        ok: true,
        payload: { status: "ok" },
        timestamp: new Date().toISOString(),
      };
      bridge.ws.send(JSON.stringify(response));

      // Client receives response
      const clientMsg = await client.waitForMessage();
      const clientData = clientMsg as Record<string, unknown>;
      expect(clientData.requestId).toBe(requestId);
      expect(clientData.ok).toBe(true);
      expect((clientData.payload as Record<string, unknown>).status).toBe("ok");

      bridge.ws.close();
      client.ws.close();
    });

    it("returns DEVICE_OFFLINE when target device not connected", async () => {
      const client = await connectWs(
        ctx,
        `/ws/client?clientId=web-dev-1&userId=dev-user&targetDeviceId=desktop-dev-1&devToken=${DEV_TOKEN}`
      );

      await client.waitForMessage();

      client.ws.send(
        JSON.stringify(
          makeRequest({ requestId: "offline-test", type: "sessions.list" })
        )
      );

      const msg = await client.waitForMessage();
      const data = msg as Record<string, unknown>;
      expect(data.ok).toBe(false);
      expect((data.error as Record<string, unknown>)?.code).toBe(
        "DEVICE_OFFLINE"
      );

      client.ws.close();
    });
  });

  // ---- Event forwarding tests ----

  describe("Events.forward", () => {
    it("forwards events from bridge to subscribed client without rewriting", async () => {
      const bridge = await connectWs(
        ctx,
        `/ws/bridge?deviceId=desktop-dev-1&userId=dev-user&devToken=${DEV_TOKEN}`
      );

      const client = await connectWs(
        ctx,
        `/ws/client?clientId=web-dev-1&userId=dev-user&targetDeviceId=desktop-dev-1&devToken=${DEV_TOKEN}`
      );

      await client.waitForMessage();

      const eventId = "evt-preserve-test";
      const sequence = 42;
      bridge.ws.send(JSON.stringify(makeEvent({ eventId, sequence })));

      const msg = await client.waitForMessage();
      const data = msg as Record<string, unknown>;
      expect(data.type).toBe("events.forward");
      expect(data.eventId).toBe(eventId);
      expect(data.sequence).toBe(sequence);

      bridge.ws.close();
      client.ws.close();
    });
  });

  // ---- Heartbeat tests ----

  describe("Heartbeat", () => {
    it("keeps bridge online with pong response", async () => {
      const bridge = await connectWs(
        ctx,
        `/ws/bridge?deviceId=desktop-dev-1&userId=dev-user&devToken=${DEV_TOKEN}`
      );

      bridge.ws.send(JSON.stringify(makeHeartbeat()));

      const msg = await bridge.waitForMessage();
      const data = msg as Record<string, unknown>;
      expect(data.type).toBe("heartbeat.pong");

      bridge.ws.close();
    });

    it("client heartbeat gets pong", async () => {
      const client = await connectWs(
        ctx,
        `/ws/client?clientId=web-dev-1&userId=dev-user&targetDeviceId=desktop-dev-1&devToken=${DEV_TOKEN}`
      );

      await client.waitForMessage();

      client.ws.send(JSON.stringify(makeHeartbeat()));

      const msg = await client.waitForMessage();
      const data = msg as Record<string, unknown>;
      expect(data.type).toBe("heartbeat.pong");

      client.ws.close();
    });
  });

  // ---- Blocked messages ----

  describe("Blocked messages", () => {
    it("rejects sessions.profile.replace", async () => {
      const client = await connectWs(
        ctx,
        `/ws/client?clientId=web-dev-1&userId=dev-user&targetDeviceId=desktop-dev-1&devToken=${DEV_TOKEN}`
      );

      await client.waitForMessage();

      client.ws.send(
        JSON.stringify(
          makeRequest({
            type: "sessions.profile.replace",
            requestId: "blocked-test-1",
          })
        )
      );

      const msg = await client.waitForMessage();
      const data = msg as Record<string, unknown>;
      expect(data.ok).toBe(false);
      expect((data.error as Record<string, unknown>)?.code).toBe("BLOCKED");

      client.ws.close();
    });
  });

  // ---- Disconnect handling ----

  describe("Disconnect handling", () => {
    it("marks bridge offline on disconnect", async () => {
      const bridge = await connectWs(
        ctx,
        `/ws/bridge?deviceId=desktop-dev-1&userId=dev-user&devToken=${DEV_TOKEN}`
      );

      bridge.ws.close();
      await bridge.waitForClose();

      // Give time for close event to process on server
      await new Promise((r) => setTimeout(r, 100));

      const client = await connectWs(
        ctx,
        `/ws/client?clientId=web-dev-1&userId=dev-user&targetDeviceId=desktop-dev-1&devToken=${DEV_TOKEN}`
      );

      await client.waitForMessage();

      client.ws.send(
        JSON.stringify(
          makeRequest({ requestId: "offline-test-2", type: "sessions.list" })
        )
      );

      const msg = await client.waitForMessage();
      const data = msg as Record<string, unknown>;
      expect(data.ok).toBe(false);
      expect((data.error as Record<string, unknown>)?.code).toBe(
        "DEVICE_OFFLINE"
      );

      client.ws.close();
    });
  });

  // ---- Targeted response routing (B2 fix) ----

  describe("Targeted response routing", () => {
    it("only the requesting client receives the response", async () => {
      const bridge = await connectWs(
        ctx,
        `/ws/bridge?deviceId=desktop-dev-1&userId=dev-user&devToken=${DEV_TOKEN}`
      );

      const clientA = await connectWs(
        ctx,
        `/ws/client?clientId=web-dev-a&userId=dev-user&targetDeviceId=desktop-dev-1&devToken=${DEV_TOKEN}`
      );
      await clientA.waitForMessage(); // device.status

      const clientB = await connectWs(
        ctx,
        `/ws/client?clientId=web-dev-b&userId=dev-user&targetDeviceId=desktop-dev-1&devToken=${DEV_TOKEN}`
      );
      await clientB.waitForMessage(); // device.status

      // Drain any buffered messages on both clients
      clientA.drainMessages();
      clientB.drainMessages();

      // Client A sends request
      const requestId = "targeted-test-1";
      clientA.ws.send(
        JSON.stringify(makeRequest({ requestId, type: "local.health.get" }))
      );

      // Bridge receives and responds
      const bridgeMsg = await bridge.waitForMessage();
      expect((bridgeMsg as Record<string, unknown>).requestId).toBe(requestId);
      bridge.ws.send(JSON.stringify({
        schemaVersion: SCHEMA_VERSION,
        requestId,
        sessionId: "test-session",
        type: "local.health.get",
        ok: true,
        payload: { status: "ok" },
        timestamp: new Date().toISOString(),
      }));

      // Client A receives response
      const msgA = await clientA.waitForMessage();
      expect((msgA as Record<string, unknown>).requestId).toBe(requestId);
      expect((msgA as Record<string, unknown>).ok).toBe(true);

      // Client B should NOT receive a response (no message buffered)
      expect(clientB.messages.length).toBe(0);

      bridge.ws.close();
      clientA.ws.close();
      clientB.ws.close();
    });

    it("unknown requestId bridge response is not broadcast", async () => {
      const bridge = await connectWs(
        ctx,
        `/ws/bridge?deviceId=desktop-dev-1&userId=dev-user&devToken=${DEV_TOKEN}`
      );

      const client = await connectWs(
        ctx,
        `/ws/client?clientId=web-dev-1&userId=dev-user&targetDeviceId=desktop-dev-1&devToken=${DEV_TOKEN}`
      );
      await client.waitForMessage();

      // Bridge sends response with unknown requestId
      bridge.ws.send(JSON.stringify({
        schemaVersion: SCHEMA_VERSION,
        requestId: "unknown-req-id",
        sessionId: "test-session",
        type: "local.health.get",
        ok: true,
        payload: { status: "ok" },
        timestamp: new Date().toISOString(),
      }));

      // Client should NOT receive this response
      // Small delay then check no message arrived
      await new Promise((r) => setTimeout(r, 200));
      // Drain the buffer to check
      const drained = client.drainMessages();
      const responseMessages = drained.filter(
        (m: any) => m.requestId === "unknown-req-id"
      );
      expect(responseMessages.length).toBe(0);

      bridge.ws.close();
      client.ws.close();
    });

    it("pending request is cleaned up after delivery", async () => {
      const bridge = await connectWs(
        ctx,
        `/ws/bridge?deviceId=desktop-dev-1&userId=dev-user&devToken=${DEV_TOKEN}`
      );

      const client = await connectWs(
        ctx,
        `/ws/client?clientId=web-dev-1&userId=dev-user&targetDeviceId=desktop-dev-1&devToken=${DEV_TOKEN}`
      );
      await client.waitForMessage();

      const requestId = "cleanup-test-1";
      client.ws.send(
        JSON.stringify(makeRequest({ requestId, type: "local.health.get" }))
      );

      const bridgeMsg = await bridge.waitForMessage();
      bridge.ws.send(JSON.stringify({
        schemaVersion: SCHEMA_VERSION,
        requestId,
        sessionId: "test-session",
        type: "local.health.get",
        ok: true,
        payload: {},
        timestamp: new Date().toISOString(),
      }));

      await client.waitForMessage();

      // Now send a second bridge response with same requestId — should NOT be delivered
      bridge.ws.send(JSON.stringify({
        schemaVersion: SCHEMA_VERSION,
        requestId,
        sessionId: "test-session",
        type: "local.health.get",
        ok: true,
        payload: { duplicate: true },
        timestamp: new Date().toISOString(),
      }));

      await new Promise((r) => setTimeout(r, 200));
      const drained = client.drainMessages();
      const duplicates = drained.filter(
        (m: any) => m.requestId === requestId
      );
      expect(duplicates.length).toBe(0);

      bridge.ws.close();
      client.ws.close();
    });

    it("disconnecting client cleans up its pending requests", async () => {
      const bridge = await connectWs(
        ctx,
        `/ws/bridge?deviceId=desktop-dev-1&userId=dev-user&devToken=${DEV_TOKEN}`
      );

      const client = await connectWs(
        ctx,
        `/ws/client?clientId=web-dev-1&userId=dev-user&targetDeviceId=desktop-dev-1&devToken=${DEV_TOKEN}`
      );
      await client.waitForMessage();

      // Client sends request then immediately disconnects
      const requestId = "disconnect-cleanup-test";
      client.ws.send(
        JSON.stringify(makeRequest({ requestId, type: "local.health.get" }))
      );

      // Wait for bridge to receive
      await bridge.waitForMessage();
      // Disconnect client before bridge responds
      client.ws.close();
      await client.waitForClose();
      await new Promise((r) => setTimeout(r, 100));

      // Bridge responds — should not crash and should not broadcast
      bridge.ws.send(JSON.stringify({
        schemaVersion: SCHEMA_VERSION,
        requestId,
        sessionId: "test-session",
        type: "local.health.get",
        ok: true,
        payload: {},
        timestamp: new Date().toISOString(),
      }));

      // No crash = pass
      await new Promise((r) => setTimeout(r, 100));

      bridge.ws.close();
    });
  });

  // ---- Multiple messages ----

  describe("Multi-message routing", () => {
    it("routes multiple request/response pairs correctly", async () => {
      const bridge = await connectWs(
        ctx,
        `/ws/bridge?deviceId=desktop-dev-1&userId=dev-user&devToken=${DEV_TOKEN}`
      );

      const client = await connectWs(
        ctx,
        `/ws/client?clientId=web-dev-1&userId=dev-user&targetDeviceId=desktop-dev-1&devToken=${DEV_TOKEN}`
      );

      await client.waitForMessage();

      const messages = [
        { requestId: "multi-1", type: "projects.list", response: { projects: [] } },
        { requestId: "multi-2", type: "sessions.list", response: { sessions: [] } },
        { requestId: "multi-3", type: "runs.list", response: { runs: [] } },
      ];

      for (const msg of messages) {
        client.ws.send(JSON.stringify(makeRequest({ requestId: msg.requestId, type: msg.type })));
        const bridgeMsg = await bridge.waitForMessage();
        const bData = bridgeMsg as Record<string, unknown>;
        expect(bData.requestId).toBe(msg.requestId);
        bridge.ws.send(JSON.stringify({
          schemaVersion: SCHEMA_VERSION,
          requestId: msg.requestId,
          sessionId: "test-session",
          type: msg.type,
          ok: true,
          payload: msg.response,
          timestamp: new Date().toISOString(),
        }));
      }

      // Collect all responses
      const responses: unknown[] = [];
      for (let i = 0; i < messages.length; i++) {
        responses.push(await client.waitForMessage());
      }
      const responseIds = responses
        .map((r: any) => r.requestId)
        .sort();
      expect(responseIds).toEqual(["multi-1", "multi-2", "multi-3"]);
      for (const r of responses) {
        expect((r as Record<string, unknown>).ok).toBe(true);
      }

      bridge.ws.close();
      client.ws.close();
    });
  });
});
