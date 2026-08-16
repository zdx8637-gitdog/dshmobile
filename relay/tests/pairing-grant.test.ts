import { describe, it, expect, beforeEach } from "vitest";
import { createTestApp } from "./helpers/setup.js";
import { seedUser } from "./helpers/seed.js";

describe("Pairing Grant（S2 设备授权码流）", () => {
  let request: ReturnType<typeof createTestApp>["request"];
  let accessToken: string;

  beforeEach(async () => {
    const ctx = createTestApp();
    request = ctx.request;
    const seeded = await seedUser(ctx.db, "phone@example.com", "password123");
    accessToken = seeded.accessToken;
  });

  async function createDeviceCode() {
    const res = await request.post("/pairing-codes/device").send({});
    expect(res.status).toBe(201);
    return res.body.data as {
      id: string;
      code: string;
      requestSecret: string;
      expiresAt: string;
    };
  }

  it("匿名出码：6 位码 + 领取凭证（无登录态）", async () => {
    const data = await createDeviceCode();
    expect(data.code).toHaveLength(6);
    expect(data.requestSecret.length).toBeGreaterThan(20);
    expect(data.expiresAt).toBeDefined();
  });

  it("未授权轮询 → pending", async () => {
    const data = await createDeviceCode();
    const res = await request.get(
      `/pairing-codes/${data.id}/status?secret=${data.requestSecret}`
    );
    expect(res.status).toBe(200);
    expect(res.body.data.status).toBe("pending");
  });

  it("错误凭证轮询 → 401", async () => {
    const data = await createDeviceCode();
    const res = await request.get(
      `/pairing-codes/${data.id}/status?secret=wrong-secret`
    );
    expect(res.status).toBe(401);
  });

  it("手机授权后轮询：一次性签发会话；再次轮询 401", async () => {
    const data = await createDeviceCode();

    // 未授权状态不能消费
    const before = await request.get(
      `/pairing-codes/${data.id}/status?secret=${data.requestSecret}`
    );
    expect(before.body.data.status).toBe("pending");

    // 手机（已登录）授权
    const grantRes = await request
      .post(`/pairing-codes/${data.id}/grant`)
      .set("Authorization", `Bearer ${accessToken}`);
    expect(grantRes.status).toBe(200);

    // 插件轮询取走会话
    const poll = await request.get(
      `/pairing-codes/${data.id}/status?secret=${data.requestSecret}`
    );
    expect(poll.status).toBe(200);
    expect(poll.body.data.status).toBe("granted");
    expect(poll.body.data.accessToken).toBeDefined();
    expect(poll.body.data.user.username).toBeDefined();

    // 取走的 token 可用
    const me = await request
      .get("/me")
      .set("Authorization", `Bearer ${poll.body.data.accessToken}`);
    expect(me.status).toBe(200);

    // 一次性：再次轮询 401
    const again = await request.get(
      `/pairing-codes/${data.id}/status?secret=${data.requestSecret}`
    );
    expect(again.status).toBe(401);
  });

  it("方向一 verify 不能核销匿名码（401）", async () => {
    const data = await createDeviceCode();
    const res = await request
      .post("/pairing-codes/verify")
      .send({ code: data.code });
    expect(res.status).toBe(401);
  });

  it("grant 对账号码（方向一码）拒绝 409", async () => {
    const created = await request
      .post("/pairing-codes")
      .set("Authorization", `Bearer ${accessToken}`);
    const id = created.body.data.id as string;

    const res = await request
      .post(`/pairing-codes/${id}/grant`)
      .set("Authorization", `Bearer ${accessToken}`);
    expect(res.status).toBe(409);
  });
});
