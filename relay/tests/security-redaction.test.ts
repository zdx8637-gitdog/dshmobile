import { describe, it, expect, beforeEach } from "vitest";
import { createTestApp } from "./helpers/setup.js";
import { seedUser } from "./helpers/seed.js";

describe("Security: Redaction", () => {
  let request: ReturnType<typeof createTestApp>["request"];

  beforeEach(async () => {
    const ctx = createTestApp();
    request = ctx.request;
    await seedUser(ctx.db, "test@example.com", "password123");
  });

  it("login response does not contain password_hash", async () => {
    const res = await request
      .post("/auth/login")
      .send({ email: "test@example.com", password: "password123" });

    expect(res.body.data?.passwordHash).toBeUndefined();
    expect(res.body.data?.password_hash).toBeUndefined();
    expect(res.body.data?.password).toBeUndefined();
  });

  it("me response does not contain password_hash", async () => {
    const loginRes = await request
      .post("/auth/login")
      .send({ email: "test@example.com", password: "password123" });

    const res = await request
      .get("/me")
      .set("Authorization", `Bearer ${loginRes.body.data.accessToken}`);

    expect(res.body.data?.passwordHash).toBeUndefined();
    expect(res.body.data?.password_hash).toBeUndefined();
  });

  it("pairing code list does not contain plaintext code", async () => {
    const loginRes = await request
      .post("/auth/login")
      .send({ email: "test@example.com", password: "password123" });

    await request
      .post("/pairing-codes")
      .set("Authorization", `Bearer ${loginRes.body.data.accessToken}`);

    const res = await request
      .get("/pairing-codes")
      .set("Authorization", `Bearer ${loginRes.body.data.accessToken}`);

    for (const code of res.body.data) {
      expect(code.code).toBeUndefined();
      expect(code.codeHash).toBeUndefined();
      expect(code.code_hash).toBeUndefined();
    }
  });
});
