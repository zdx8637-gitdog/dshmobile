import { describe, it, expect, beforeEach } from "vitest";
import { createTestApp } from "./helpers/setup.js";

describe("Phase 6-D: Auth REST", () => {
  let request: ReturnType<typeof createTestApp>["request"];

  beforeEach(() => {
    const ctx = createTestApp();
    request = ctx.request;
  });

  describe("POST /auth/register", () => {
    it("registers a new user with username and password", async () => {
      const res = await request
        .post("/auth/register")
        .send({ username: "alice", password: "secret123", displayName: "Alice" });

      expect(res.status).toBe(201);
      expect(res.body.data.username).toBe("alice");
      expect(res.body.data.id).toBeDefined();
    });

    it("rejects duplicate username", async () => {
      await request
        .post("/auth/register")
        .send({ username: "bob", password: "secret123" });

      const res = await request
        .post("/auth/register")
        .send({ username: "bob", password: "other456" });

      expect(res.status).toBe(409);
      expect(res.body.error.code).toBe("CONFLICT");
    });

    it("rejects short password", async () => {
      const res = await request
        .post("/auth/register")
        .send({ username: "charlie", password: "12" });

      expect(res.status).toBe(400);
    });

    it("rejects invalid username", async () => {
      const res = await request
        .post("/auth/register")
        .send({ username: "bad user!", password: "secret123" });

      expect(res.status).toBe(400);
    });
  });

  describe("POST /auth/login with username", () => {
    beforeEach(async () => {
      await request
        .post("/auth/register")
        .send({ username: "loginuser", password: "mypassword" });
    });

    it("logs in with username", async () => {
      const res = await request
        .post("/auth/login")
        .send({ username: "loginuser", password: "mypassword" });

      expect(res.status).toBe(200);
      expect(res.body.data.accessToken).toBeDefined();
      expect(res.body.data.refreshToken).toBeDefined();
      expect(res.body.data.user.username).toBe("loginuser");
    });

    it("rejects wrong password", async () => {
      const res = await request
        .post("/auth/login")
        .send({ username: "loginuser", password: "wrong" });

      expect(res.status).toBe(401);
    });
  });
});
