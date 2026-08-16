import { describe, it, expect, beforeEach } from "vitest";
import { createTestApp } from "./helpers/setup.js";
import { seedUser } from "./helpers/seed.js";

describe("Pairing Codes", () => {
  let request: ReturnType<typeof createTestApp>["request"];
  let accessToken: string;

  beforeEach(async () => {
    const ctx = createTestApp();
    request = ctx.request;
    const { accessToken: token } = await seedUser(ctx.db, "test@example.com", "password123");
    accessToken = token;
  });

  it("creates a pairing code", async () => {
    const res = await request
      .post("/pairing-codes")
      .set("Authorization", `Bearer ${accessToken}`);

    expect(res.status).toBe(201);
    expect(res.body.data.id).toBeDefined();
    expect(res.body.data.code).toBeDefined();
    expect(res.body.data.code).toHaveLength(6);
    expect(res.body.data.expiresAt).toBeDefined();
  });

  it("lists active pairing codes (no plaintext code)", async () => {
    await request
      .post("/pairing-codes")
      .set("Authorization", `Bearer ${accessToken}`);

    const res = await request
      .get("/pairing-codes")
      .set("Authorization", `Bearer ${accessToken}`);

    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.data)).toBe(true);
    expect(res.body.data.length).toBe(1);
    // Plaintext code should never be returned in listing
    expect(res.body.data[0].code).toBeUndefined();
  });

  it("cancels a pairing code", async () => {
    const create = await request
      .post("/pairing-codes")
      .set("Authorization", `Bearer ${accessToken}`);

    const res = await request
      .post(`/pairing-codes/${create.body.data.id}/cancel`)
      .set("Authorization", `Bearer ${accessToken}`);

    expect(res.status).toBe(200);

    // Verify it's no longer in list
    const list = await request
      .get("/pairing-codes")
      .set("Authorization", `Bearer ${accessToken}`);
    expect(list.body.data.length).toBe(0);
  });

  it("returns 404 for non-existent pairing code", async () => {
    const res = await request
      .post("/pairing-codes/nonexistent-id/cancel")
      .set("Authorization", `Bearer ${accessToken}`);

    expect(res.status).toBe(404);
  });
});
