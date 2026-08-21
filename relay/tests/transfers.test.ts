/**
 * Data Plane tests — 文件传输 spool：announce 幂等、分块上传 offset 强校验、
 * 归属隔离、complete 校验、控制面投递指令、设备下载、清理。
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { createHash } from "node:crypto";
import { createWsTestApp } from "./helpers/ws-setup.js";
import type { WsTestContext } from "./helpers/ws-setup.js";
import { connectAuthWs } from "./helpers/ws-auth.js";
import { signAccessToken, signDeviceToken } from "../src/lib/jwt.js";
import { generateId } from "../src/lib/id-generator.js";
import { hashSecret } from "../src/lib/hash.js";
import * as transferService from "../src/services/transfer-service.js";
import { config } from "../src/config.js";

function now() {
  return new Date().toISOString();
}

async function createUser(db: any, username: string, password = "password123") {
  const id = generateId();
  const hash = await hashSecret(password);
  const ts = now();
  db.prepare(
    `INSERT INTO users (id, username, email, password_hash, display_name, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(id, username, `${username}@test.com`, hash, username, ts, ts);
  return { userId: id, username };
}

async function createDevice(db: any, userId: string, deviceId: string, label = "Test Device") {
  const ts = now();
  db.prepare(
    `INSERT INTO devices (id, user_id, label, platform, status, created_at)
     VALUES (?, ?, ?, ?, 'offline', ?)`,
  ).run(deviceId, userId, label, "other", ts);
}

function sha256hex(buf: Buffer): string {
  return createHash("sha256").update(buf).digest("hex");
}

const CONTENT = Buffer.from("hello dshmobile data plane " + "x".repeat(2048));

describe("Data plane: transfers", () => {
  let ctx: WsTestContext;

  beforeEach(async () => {
    ctx = await createWsTestApp();
  });

  afterEach(async () => {
    // 强制清理本次测试的全部 spool（把 now 推到 TTL+宽限之外）
    await transferService.sweep(Date.now() + config.transferTTLMs + config.transferDeliveredGraceMs + 60000);
    await ctx.close();
  });

  function announceFor(token: string, body: unknown) {
    return fetch(`${ctx.baseUrl}/transfers`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
      body: JSON.stringify(body),
    });
  }

  it("401 without auth", async () => {
    const res = await fetch(`${ctx.baseUrl}/transfers`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    });
    expect(res.status).toBe(401);
  });

  it("404 when announcing to another user's device", async () => {
    const { userId } = await createUser(ctx.db, "tf-u1");
    const { userId: other } = await createUser(ctx.db, "tf-u2");
    await createDevice(ctx.db, other, "dev-other");
    const token = signAccessToken(userId);
    const res = await announceFor(token, {
      deviceId: "dev-other",
      fileId: sha256hex(CONTENT),
      name: "a.bin",
      size: CONTENT.length,
      sha256: sha256hex(CONTENT),
      targetPath: "a.bin",
    });
    expect(res.status).toBe(404);
  });

  it("idempotent announce returns the same transferId", async () => {
    const { userId } = await createUser(ctx.db, "tf-idem");
    await createDevice(ctx.db, userId, "dev-idem");
    const token = signAccessToken(userId);
    const body = {
      deviceId: "dev-idem",
      fileId: sha256hex(CONTENT),
      name: "hello.txt",
      size: CONTENT.length,
      sha256: sha256hex(CONTENT),
      targetPath: "docs/hello.txt",
    };
    const a = await (await announceFor(token, body)).json();
    const b = await (await announceFor(token, body)).json();
    expect(a.data.transferId).toBe(b.data.transferId);
    expect(a.data.status).toBe("uploading");
  });

  it("upload → complete → bridge receives transfer.deliver → delivered", async () => {
    const { userId } = await createUser(ctx.db, "tf-full");
    await createDevice(ctx.db, userId, "dev-full");
    const userTok = signAccessToken(userId);
    const deviceTok = signDeviceToken("dev-full", userId);
    const bridge = await connectAuthWs(ctx, "/ws/bridge", deviceTok);
    const fileId = sha256hex(CONTENT);

    const ann = await announceFor(userTok, {
      deviceId: "dev-full",
      fileId,
      name: "hello.txt",
      size: CONTENT.length,
      sha256: fileId,
      targetPath: "docs/hello.txt",
    });
    expect(ann.status).toBe(201);
    const { transferId } = (await ann.json()).data;

    const put = (offset: number, body: Buffer) =>
      fetch(`${ctx.baseUrl}/transfers/${transferId}/chunks`, {
        method: "PUT",
        headers: {
          "content-type": "application/octet-stream",
          "x-chunk-offset": String(offset),
          authorization: `Bearer ${userTok}`,
        },
        body: new Uint8Array(body),
      });

    const half = Math.floor(CONTENT.length / 2);
    expect((await put(0, CONTENT.subarray(0, half))).status).toBe(200);
    // 错位 offset → 409（服务端强校验）
    expect((await put(0, CONTENT.subarray(half))).status).toBe(409);
    expect((await put(half, CONTENT.subarray(half))).status).toBe(200);

    const st = await (
      await fetch(`${ctx.baseUrl}/transfers/${transferId}`, {
        headers: { authorization: `Bearer ${userTok}` },
      })
    ).json();
    expect(st.data.received).toBe(CONTENT.length);

    // complete → 校验通过 → 控制面投递指令到 bridge
    const c = await fetch(`${ctx.baseUrl}/transfers/${transferId}/complete`, {
      method: "POST",
      headers: { authorization: `Bearer ${userTok}` },
    });
    expect(c.status).toBe(200);

    const msg = (await bridge.nextMessage(5000)) as any;
    expect(msg.kind).toBe("request");
    expect(msg.type).toBe("transfer.deliver");
    expect(msg.payload.fileId).toBe(fileId);
    expect(msg.payload.targetPath).toBe("docs/hello.txt");

    // bridge 回执 ok → 状态 delivered
    bridge.ws.send(
      JSON.stringify({
        schemaVersion: 1,
        envelopeId: "resp-1",
        kind: "response",
        type: "transfer.deliver",
        requestId: msg.requestId,
        sentAt: now(),
        actor: { role: "bridge", deviceId: "dev-full" },
        payload: { ok: true, data: { path: "/tmp/hello.txt" } },
      }),
    );
    await new Promise((r) => setTimeout(r, 300));
    expect(transferService.get(transferId)?.status).toBe("delivered");

    bridge.ws.close();
  });

  it("checksum mismatch → 422 and failed", async () => {
    const { userId } = await createUser(ctx.db, "tf-badsha");
    await createDevice(ctx.db, userId, "dev-badsha");
    const token = signAccessToken(userId);
    const fileId = sha256hex(CONTENT);
    const ann = await announceFor(token, {
      deviceId: "dev-badsha",
      fileId,
      name: "x.bin",
      size: CONTENT.length,
      sha256: "0".repeat(64), // 错误的声明哈希
      targetPath: "x.bin",
    });
    const { transferId } = (await ann.json()).data;
    const up = await fetch(`${ctx.baseUrl}/transfers/${transferId}/chunks`, {
      method: "PUT",
      headers: {
        "content-type": "application/octet-stream",
        "x-chunk-offset": "0",
        authorization: `Bearer ${token}`,
      },
      body: new Uint8Array(CONTENT),
    });
    expect(up.status).toBe(200);
    const c = await fetch(`${ctx.baseUrl}/transfers/${transferId}/complete`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}` },
    });
    expect(c.status).toBe(422);
    expect(transferService.get(transferId)?.status).toBe("failed");
  });

  it("download requires the device token of the same device", async () => {
    const { userId } = await createUser(ctx.db, "tf-dl");
    await createDevice(ctx.db, userId, "dev-dl");
    const token = signAccessToken(userId);
    const fileId = sha256hex(CONTENT);
    const ann = await announceFor(token, {
      deviceId: "dev-dl",
      fileId,
      name: "d.bin",
      size: CONTENT.length,
      sha256: fileId,
      targetPath: "d.bin",
    });
    const { transferId } = (await ann.json()).data;
    await fetch(`${ctx.baseUrl}/transfers/${transferId}/chunks`, {
      method: "PUT",
      headers: {
        "content-type": "application/octet-stream",
        "x-chunk-offset": "0",
        authorization: `Bearer ${token}`,
      },
      body: new Uint8Array(CONTENT),
    });
    await fetch(`${ctx.baseUrl}/transfers/${transferId}/complete`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}` },
    });
    await new Promise((r) => setTimeout(r, 200));

    // 错误设备 token → 404
    const { userId: other } = await createUser(ctx.db, "tf-dl-other");
    await createDevice(ctx.db, other, "dev-other2");
    const wrongTok = signDeviceToken("dev-other2", other);
    const bad = await fetch(`${ctx.baseUrl}/transfers/${transferId}/download`, {
      headers: { authorization: `Bearer ${wrongTok}` },
    });
    expect(bad.status).toBe(404);

    // 正确设备 token → 200 且字节一致
    const good = await fetch(`${ctx.baseUrl}/transfers/${transferId}/download`, {
      headers: { authorization: `Bearer ${signDeviceToken("dev-dl", userId)}` },
    });
    expect(good.status).toBe(200);
    const bytes = Buffer.from(await good.arrayBuffer());
    expect(sha256hex(bytes)).toBe(fileId);
  });

  it("download: owner user token works, other user's token rejected", async () => {
    const { userId } = await createUser(ctx.db, "tf-udl");
    await createDevice(ctx.db, userId, "dev-udl");
    const token = signAccessToken(userId);
    const fileId = sha256hex(CONTENT);
    const ann = await announceFor(token, {
      deviceId: "dev-udl",
      fileId,
      name: "u.bin",
      size: CONTENT.length,
      sha256: fileId,
      targetPath: "u.bin",
    });
    const { transferId } = (await ann.json()).data;
    await fetch(`${ctx.baseUrl}/transfers/${transferId}/chunks`, {
      method: "PUT",
      headers: {
        "content-type": "application/octet-stream",
        "x-chunk-offset": "0",
        authorization: `Bearer ${token}`,
      },
      body: new Uint8Array(CONTENT),
    });
    await fetch(`${ctx.baseUrl}/transfers/${transferId}/complete`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}` },
    });
    await new Promise((r) => setTimeout(r, 200));

    // 其他已登录用户用用户 token 下载 → 404（owner 隔离）
    const { userId: otherUser } = await createUser(ctx.db, "tf-udl-other");
    const otherTok = signAccessToken(otherUser);
    const bad = await fetch(`${ctx.baseUrl}/transfers/${transferId}/download`, {
      headers: { authorization: `Bearer ${otherTok}` },
    });
    expect(bad.status).toBe(404);

    // owner 用户 token 下载 → 200 且字节一致
    const good = await fetch(`${ctx.baseUrl}/transfers/${transferId}/download`, {
      headers: { authorization: `Bearer ${token}` },
    });
    expect(good.status).toBe(200);
    const bytes = Buffer.from(await good.arrayBuffer());
    expect(sha256hex(bytes)).toBe(fileId);
  });

  it("reverse direction (download): ready without deliver, swept after cache TTL", async () => {
    const { userId } = await createUser(ctx.db, "tf-rev");
    await createDevice(ctx.db, userId, "dev-rev");
    const token = signAccessToken(userId);
    const fileId = sha256hex(CONTENT);
    const bridge = await connectAuthWs(ctx, "/ws/bridge", signDeviceToken("dev-rev", userId));

    const ann = await announceFor(token, {
      deviceId: "dev-rev",
      fileId,
      name: "img.png",
      size: CONTENT.length,
      sha256: fileId,
      targetPath: "attachments/x",
      direction: "download",
    });
    const { transferId } = (await ann.json()).data;
    await fetch(`${ctx.baseUrl}/transfers/${transferId}/chunks`, {
      method: "PUT",
      headers: {
        "content-type": "application/octet-stream",
        "x-chunk-offset": "0",
        authorization: `Bearer ${token}`,
      },
      body: new Uint8Array(CONTENT),
    });
    const c = await fetch(`${ctx.baseUrl}/transfers/${transferId}/complete`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}` },
    });
    expect(c.status).toBe(200);
    await new Promise((r) => setTimeout(r, 300));

    // ready 即终态，且桥不收到 transfer.deliver
    const t = transferService.get(transferId);
    expect(t?.status).toBe("ready");
    expect(t?.direction).toBe("download");
    const deliverMsgs = bridge.drainMessages().filter((m: any) => m.type === "transfer.deliver");
    expect(deliverMsgs.length).toBe(0);

    // 用户 token 可下载
    const dl = await fetch(`${ctx.baseUrl}/transfers/${transferId}/download`, {
      headers: { authorization: `Bearer ${token}` },
    });
    expect(dl.status).toBe(200);

    // 缓存 TTL 过后 sweep 清理
    const removed = await transferService.sweep(Date.now() + config.attachmentCacheTTLMs + 60000);
    expect(removed).toBeGreaterThanOrEqual(1);
    bridge.ws.close();
  });
});
