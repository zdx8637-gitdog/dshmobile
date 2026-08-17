import { describe, it, expect, beforeEach } from "vitest";
import { createTestApp } from "./helpers/setup.js";
import { seedUser } from "./helpers/seed.js";

describe("Security: Rate limiting", () => {
  let request: ReturnType<typeof createTestApp>["request"];

  beforeEach(async () => {
    const ctx = createTestApp();
    request = ctx.request;
    await seedUser(ctx.db, "test@example.com", "password123");
  });

  it("rate limits auth login endpoint", async () => {
    // Use non-existent email for fast rejection (no bcrypt)
    const body = { email: "nonexistent@example.com", password: "x" };

    const results: number[] = [];
    for (let i = 0; i < 12; i++) {
      const res = await request.post("/auth/login").send(body);
      results.push(res.status);
    }

    // First 10 should be 401 (user not found), next should be 429
    expect(results.filter((s) => s === 401).length).toBe(10);
    expect(results.filter((s) => s === 429).length).toBe(2);
  }, 15000);

  it("rate limits pairing code creation", async () => {
    const loginRes = await request
      .post("/auth/login")
      .send({ email: "test@example.com", password: "password123" });
    const token = loginRes.body.data.accessToken;

    const results: number[] = [];
    for (let i = 0; i < 8; i++) {
      const res = await request
        .post("/pairing-codes")
        .set("Authorization", `Bearer ${token}`);
      results.push(res.status);
    }

    // 流程面限流已放宽到 300/min（verify 端点保持 5/min 严格）：
    // 8 次创建全部放行，不触发 429
    expect(results.filter((s) => s === 201).length).toBe(8);
    expect(results.filter((s) => s === 429).length).toBe(0);
  }, 15000);
});
