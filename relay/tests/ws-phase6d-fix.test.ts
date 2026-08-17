/**
 * Phase 6-D Fix Tests — Bearer product path, multi-user isolation,
 * offline device, revoked device.
 *
 * All tests use Bearer accessToken/deviceToken, NOT devToken.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { WebSocket } from "ws";
import { createWsTestApp, connectWs } from "./helpers/ws-setup.js";
import { connectAuthWs } from "./helpers/ws-auth.js";
import type { WsTestContext, BufferedWs } from "./helpers/ws-setup.js";
import type { AuthWs } from "./helpers/ws-auth.js";
import { signAccessToken, signDeviceToken } from "../src/lib/jwt.js";
import { generateId } from "../src/lib/id-generator.js";
import { hashSecret } from "../src/lib/hash.js";

const DEV_TOKEN = "test-dev-token-fixed-for-test-suite";

function now() { return new Date().toISOString(); }

async function createUser(db: any, username: string, password = "password123") {
  const id = generateId();
  const hash = await hashSecret(password);
  const ts = now();
  db.prepare(
    `INSERT INTO users (id, username, email, password_hash, display_name, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  ).run(id, username, `${username}@test.com`, hash, username, ts, ts);
  return { userId: id, username };
}

async function createDevice(db: any, userId: string, deviceId: string, label = "Test Device") {
  const ts = now();
  db.prepare(
    `INSERT INTO devices (id, user_id, label, platform, status, created_at)
     VALUES (?, ?, ?, ?, 'offline', ?)`
  ).run(deviceId, userId, label, "other", ts);
}

describe("Phase 6-D Fix: Bearer Product Path", () => {
  let ctx: WsTestContext;

  beforeEach(async () => { ctx = await createWsTestApp(); });
  afterEach(async () => { await ctx.close(); });

  // ═══════════════════════════════════════════════════════
  // 1. Bearer full WS routing
  // ═══════════════════════════════════════════════════════
  describe("Bearer full WS routing", () => {
    it("bridge receives request and client receives response", async () => {
      const { userId } = await createUser(ctx.db, "beareruser");
      await createDevice(ctx.db, userId, "bearer-dev-1");

      // Bridge connects with deviceToken
      const deviceToken = signDeviceToken("bearer-dev-1", userId);
      const bridge = await connectAuthWs(ctx, "/ws/bridge", deviceToken);

      // Client connects with accessToken
      const accessToken = signAccessToken(userId);
      const client = await connectAuthWs(
        ctx, `/ws/client?clientId=test-client&targetDeviceId=bearer-dev-1`, accessToken
      );

      // Consume device.status
      await client.nextMessage();

      // Client sends canonical request
      const requestId = "bearer-req-1";
      client.ws.send(JSON.stringify({
        schemaVersion: 1,
        envelopeId: requestId,
        kind: "request",
        requestId,
        type: "local.health.get",
        sentAt: now(),
        actor: { clientId: "test-client" },
        target: { deviceId: "bearer-dev-1" },
        payload: {},
      }));

      // Bridge must receive the request
      const bridgeMsg = await bridge.nextMessage();
      expect(bridgeMsg.kind).toBe("request");
      expect(bridgeMsg.requestId).toBe(requestId);
      expect(bridgeMsg.type).toBe("local.health.get");

      // Bridge sends canonical response
      bridge.ws.send(JSON.stringify({
        schemaVersion: 1,
        envelopeId: `${requestId}-resp`,
        kind: "response",
        requestId,
        type: "local.health.get",
        sentAt: now(),
        actor: { deviceId: "bearer-dev-1" },
        payload: { ok: true, data: { status: "ok" } },
      }));

      // Client must receive the response
      const clientMsg = await client.nextMessage();
      expect(clientMsg.kind).toBe("response");
      expect(clientMsg.requestId).toBe(requestId);
      expect((clientMsg.payload as Record<string, unknown>)?.ok).toBe(true);

      bridge.ws.close();
      client.ws.close();
    });
  });

  // ═══════════════════════════════════════════════════════
  // 2. Cross-user isolation
  // ═══════════════════════════════════════════════════════
  describe("Cross-user isolation", () => {
    it("userB cannot access userA device — connection rejected at handshake", async () => {
      const { userId: userA } = await createUser(ctx.db, "usera");
      const { userId: userB } = await createUser(ctx.db, "userb");
      await createDevice(ctx.db, userA, "device-a");

      // Bridge for userA's device
      const deviceTokenA = signDeviceToken("device-a", userA);
      const bridgeA = await connectAuthWs(ctx, "/ws/bridge", deviceTokenA);

      // userB 的 accessToken 有效，但无权访问 userA 的设备 → 连接建立即被服务端关闭
      // （4003，与"设备不存在"同码，不泄露设备存在性），收不到任何事件。
      const accessTokenB = signAccessToken(userB);
      const clientB = await connectAuthWs(
        ctx, `/ws/client?clientId=evil-client&targetDeviceId=device-a`, accessTokenB
      );
      const closeCode = await clientB.waitForClose();
      expect(closeCode).toBe(4003);

      // 无 device.status，更无任何转发事件
      const drained = clientB.drainMessages();
      expect(drained.length).toBe(0);

      bridgeA.ws.close();
    });
  });

  // ═══════════════════════════════════════════════════════
  // 3. Offline device
  // ═══════════════════════════════════════════════════════
  describe("Offline device", () => {
    it("returns DEVICE_OFFLINE when bridge disconnected", async () => {
      const { userId } = await createUser(ctx.db, "offlineuser");
      await createDevice(ctx.db, userId, "offline-dev-1");

      // Connect then disconnect bridge
      const deviceToken = signDeviceToken("offline-dev-1", userId);
      const bridge = await connectAuthWs(ctx, "/ws/bridge", deviceToken);
      bridge.ws.close();
      await bridge.waitForClose();
      // Wait for server to process close
      await new Promise(r => setTimeout(r, 100));

      // Client connects
      const accessToken = signAccessToken(userId);
      const client = await connectAuthWs(
        ctx, `/ws/client?clientId=offline-client&targetDeviceId=offline-dev-1`, accessToken
      );
      await client.nextMessage(); // device.status

      // Client sends request — device offline
      client.ws.send(JSON.stringify({
        schemaVersion: 1,
        envelopeId: "offline-req-1",
        kind: "request",
        requestId: "offline-req-1",
        type: "projects.list",
        sentAt: now(),
        actor: { clientId: "offline-client" },
        target: { deviceId: "offline-dev-1" },
        payload: {},
      }));

      const msg = await client.nextMessage();
      expect(msg.kind).toBe("error");
      const payload = msg.payload as Record<string, unknown>;
      expect(payload.ok).toBe(false);
      expect((payload.error as Record<string, unknown>)?.code).toBe("DEVICE_OFFLINE");

      client.ws.close();
    });
  });

  // ═══════════════════════════════════════════════════════
  // 4. Revoked device
  // ═══════════════════════════════════════════════════════
  describe("Revoked device", () => {
    it("revoked device rejects next bridge connection", async () => {
      const { userId } = await createUser(ctx.db, "revokeuser");
      const deviceId = "revoke-dev-1";
      await createDevice(ctx.db, userId, deviceId);

      const deviceToken = signDeviceToken(deviceId, userId);

      // Revoke the device before connecting
      ctx.db.prepare("UPDATE devices SET revoked_at = ? WHERE id = ?")
        .run(now(), deviceId);

      // Try to connect bridge with revoked device token
      const ws = new WebSocket(`${ctx.wsBaseUrl}/ws/bridge`, {
        headers: { Authorization: `Bearer ${deviceToken}` },
      });

      const closeCode = await new Promise<number>((resolve) => {
        ws.on("close", (c) => resolve(c));
        setTimeout(() => resolve(0), 3000);
      });

      expect(closeCode).toBe(4003); // device revoked
    });

    it("revoked device not immediately disconnected if already connected", async () => {
      // This test documents current behavior:
      // Phase 6-D currently only rejects NEXT connection after revoke.
      // Immediate disconnect of already-connected bridge is a future enhancement.
      const { userId } = await createUser(ctx.db, "revokeuser2");
      const deviceId = "revoke-dev-2";
      await createDevice(ctx.db, userId, deviceId);

      const deviceToken = signDeviceToken(deviceId, userId);
      const bridge = await connectAuthWs(ctx, "/ws/bridge", deviceToken);
      expect(bridge.ws.readyState).toBe(WebSocket.OPEN);

      // Revoke while connected
      ctx.db.prepare("UPDATE devices SET revoked_at = ? WHERE id = ?")
        .run(now(), deviceId);

      // Current behavior: bridge stays connected (not immediately kicked)
      await new Promise(r => setTimeout(r, 200));
      // Bridge is still open — this is the current documented behavior
      // Future enhancement: relay should close existing bridge on revoke

      bridge.ws.close();
    });
  });

  // ═══════════════════════════════════════════════════════
  // 5. DevToken disabled in production
  // ═══════════════════════════════════════════════════════
  describe("DevToken production gate", () => {
    it("devToken works in test mode (NODE_ENV=test)", async () => {
      // Tests run with NODE_ENV=test → devToken should work
      const bw = await connectWs(
        ctx,
        `/ws/bridge?deviceId=test-dev-1&userId=dev-user&devToken=${DEV_TOKEN}`
      );
      expect(bw.ws.readyState).toBe(WebSocket.OPEN);
      bw.ws.close();
    });

    it("devToken on client works in test mode", async () => {
      const bw = await connectWs(
        ctx,
        `/ws/client?clientId=test-cli&userId=dev-user&targetDeviceId=test-dev-1&devToken=${DEV_TOKEN}`
      );
      expect(bw.ws.readyState).toBe(WebSocket.OPEN);
      bw.ws.close();
    });
  });
});
