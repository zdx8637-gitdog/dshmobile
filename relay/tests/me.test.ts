import { describe, it, expect, beforeEach } from "vitest";
import { createTestApp } from "./helpers/setup.js";
import { seedUser } from "./helpers/seed.js";

describe("GET /me", () => {
  let request: ReturnType<typeof createTestApp>["request"];
  let accessToken: string;

  beforeEach(async () => {
    const ctx = createTestApp();
    request = ctx.request;
    const { accessToken: token } = await seedUser(ctx.db, "test@example.com", "password123");
    accessToken = token;
  });

  it("returns user profile when authenticated", async () => {
    const res = await request
      .get("/me")
      .set("Authorization", `Bearer ${accessToken}`);

    expect(res.status).toBe(200);
    expect(res.body.data.email).toBe("test@example.com");
    expect(res.body.data.displayName).toBeDefined();
  });

  it("returns 401 when not authenticated", async () => {
    const res = await request.get("/me");

    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe("AUTH_ERROR");
  });

  it("returns 401 with invalid token", async () => {
    const res = await request
      .get("/me")
      .set("Authorization", "Bearer invalid-token");

    expect(res.status).toBe(401);
  });
});
