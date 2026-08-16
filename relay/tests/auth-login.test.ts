import { describe, it, expect, beforeEach } from "vitest";
import { createTestApp } from "./helpers/setup.js";
import { seedUser } from "./helpers/seed.js";

describe("POST /auth/login", () => {
  let request: ReturnType<typeof createTestApp>["request"];
  let db: any;

  beforeEach(async () => {
    const ctx = createTestApp();
    request = ctx.request;
    db = ctx.db;
    await seedUser(db, "test@example.com", "password123");
  });

  it("returns accessToken and refreshToken on success", async () => {
    const res = await request
      .post("/auth/login")
      .send({ email: "test@example.com", password: "password123" });

    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.data.accessToken).toBeDefined();
    expect(res.body.data.refreshToken).toBeDefined();
    expect(res.body.data.user.username).toBe("test");
  });

  it("returns 401 for wrong password", async () => {
    const res = await request
      .post("/auth/login")
      .send({ email: "test@example.com", password: "wrongpassword" });

    expect(res.status).toBe(401);
    expect(res.body.ok).toBe(false);
    expect(res.body.error.code).toBe("AUTH_ERROR");
  });

  it("returns 401 for disabled user", async () => {
    db.prepare("UPDATE users SET disabled_at = ? WHERE email = ?").run(
      new Date().toISOString(),
      "test@example.com"
    );

    const res = await request
      .post("/auth/login")
      .send({ email: "test@example.com", password: "password123" });

    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe("AUTH_ERROR");
  });

  it("returns 400 for missing fields", async () => {
    const res = await request.post("/auth/login").send({ email: "test@example.com" });

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("VALIDATION_ERROR");
  });

  it("returns 401 for non-existent user", async () => {
    const res = await request
      .post("/auth/login")
      .send({ email: "nonexistent@example.com", password: "password123" });

    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe("AUTH_ERROR");
  });
});
