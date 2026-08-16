import { describe, it, expect, beforeEach } from "vitest";
import { createTestApp } from "./helpers/setup.js";
import { seedUser } from "./helpers/seed.js";

describe("POST /auth/logout", () => {
  let request: ReturnType<typeof createTestApp>["request"];

  beforeEach(async () => {
    const ctx = createTestApp();
    request = ctx.request;
    await seedUser(ctx.db, "test@example.com", "password123");
  });

  async function login(): Promise<string> {
    const res = await request
      .post("/auth/login")
      .send({ email: "test@example.com", password: "password123" });
    return res.body.data.refreshToken;
  }

  it("revokes session successfully", async () => {
    const refreshToken = await login();

    const res = await request.post("/auth/logout").send({ refreshToken });

    expect(res.status).toBe(200);
  });

  it("refresh fails after logout", async () => {
    const refreshToken = await login();

    await request.post("/auth/logout").send({ refreshToken });

    const res = await request.post("/auth/refresh").send({ refreshToken });

    expect(res.status).toBe(401);
  });

  it("logout with invalid token returns 200 (no-op)", async () => {
    const res = await request
      .post("/auth/logout")
      .send({ refreshToken: "invalid-token" });

    expect(res.status).toBe(200);
  });
});
