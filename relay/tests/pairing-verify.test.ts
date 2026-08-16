import { describe, it, expect, beforeEach } from "vitest";
import { createTestApp } from "./helpers/setup.js";
import { seedUser } from "./helpers/seed.js";

describe("Pairing Codes Verify（扫码登录方向一）", () => {
  let request: ReturnType<typeof createTestApp>["request"];
  let accessToken: string;

  beforeEach(async () => {
    const ctx = createTestApp();
    request = ctx.request;
    const { accessToken: token } = await seedUser(ctx.db, "test@example.com", "password123");
    accessToken = token;
  });

  async function createCode(): Promise<string> {
    const res = await request
      .post("/pairing-codes")
      .set("Authorization", `Bearer ${accessToken}`);
    expect(res.status).toBe(201);
    return res.body.data.code as string;
  }

  it("无登录态凭有效码换取会话 token（含用户信息）", async () => {
    const code = await createCode();

    const res = await request
      .post("/pairing-codes/verify")
      .send({ code });

    expect(res.status).toBe(200);
    expect(res.body.data.accessToken).toBeDefined();
    expect(res.body.data.refreshToken).toBeDefined();
    expect(res.body.data.user.id).toBeDefined();
    expect(res.body.data.user.username).toBeDefined();

    // 拿到的 access token 可以正常访问受保护接口
    const me = await request
      .get("/me")
      .set("Authorization", `Bearer ${res.body.data.accessToken}`);
    expect(me.status).toBe(200);
  });

  it("错误码返回 401", async () => {
    const res = await request
      .post("/pairing-codes/verify")
      .send({ code: "000000" });

    expect(res.status).toBe(401);
  });

  it("同一码只能核销一次（第二次 401）", async () => {
    const code = await createCode();

    const first = await request.post("/pairing-codes/verify").send({ code });
    expect(first.status).toBe(200);

    const second = await request.post("/pairing-codes/verify").send({ code });
    expect(second.status).toBe(401);
  });

  it("已取消的码不可核销", async () => {
    const create = await request
      .post("/pairing-codes")
      .set("Authorization", `Bearer ${accessToken}`);
    const id = create.body.data.id as string;
    const code = create.body.data.code as string;

    await request
      .post(`/pairing-codes/${id}/cancel`)
      .set("Authorization", `Bearer ${accessToken}`);

    const res = await request.post("/pairing-codes/verify").send({ code });
    expect(res.status).toBe(401);
  });

  it("缺失/空码返回 400", async () => {
    const res = await request.post("/pairing-codes/verify").send({});
    expect(res.status).toBe(400);
  });
});
