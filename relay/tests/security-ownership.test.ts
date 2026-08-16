import { describe, it, expect, beforeEach } from "vitest";
import { createTestApp } from "./helpers/setup.js";
import { seedUser } from "./helpers/seed.js";

describe("Security: Ownership checks", () => {
  let request: ReturnType<typeof createTestApp>["request"];
  let accessTokenA: string;
  let accessTokenB: string;

  beforeEach(async () => {
    const ctx = createTestApp();
    request = ctx.request;
    const a = await seedUser(ctx.db, "user-a@example.com", "password123");
    const b = await seedUser(ctx.db, "user-b@example.com", "password123");
    accessTokenA = a.accessToken;
    accessTokenB = b.accessToken;
  });

  it("User A cannot access User B's device", async () => {
    // User B creates a device
    const create = await request
      .post("/devices")
      .set("Authorization", `Bearer ${accessTokenB}`)
      .send({ label: "B's Device" });

    // User A tries to access it
    const res = await request
      .get(`/devices/${create.body.data.id}`)
      .set("Authorization", `Bearer ${accessTokenA}`);

    expect(res.status).toBe(404);
  });

  it("User A cannot revoke User B's device", async () => {
    const create = await request
      .post("/devices")
      .set("Authorization", `Bearer ${accessTokenB}`)
      .send({ label: "B's Device" });

    const res = await request
      .post(`/devices/${create.body.data.id}/revoke`)
      .set("Authorization", `Bearer ${accessTokenA}`);

    expect(res.status).toBe(404);
  });

  it("User A cannot cancel User B's pairing code", async () => {
    const create = await request
      .post("/pairing-codes")
      .set("Authorization", `Bearer ${accessTokenB}`);

    const res = await request
      .post(`/pairing-codes/${create.body.data.id}/cancel`)
      .set("Authorization", `Bearer ${accessTokenA}`);

    expect(res.status).toBe(404);
  });

  it("User A cannot see User B's devices in their list", async () => {
    await request
      .post("/devices")
      .set("Authorization", `Bearer ${accessTokenB}`)
      .send({ label: "B's Device" });

    const res = await request
      .get("/devices")
      .set("Authorization", `Bearer ${accessTokenA}`);

    expect(res.body.data).toEqual([]);
  });

  it("User A cannot see User B's pairing codes in their list", async () => {
    await request
      .post("/pairing-codes")
      .set("Authorization", `Bearer ${accessTokenB}`);

    const res = await request
      .get("/pairing-codes")
      .set("Authorization", `Bearer ${accessTokenA}`);

    expect(res.body.data).toEqual([]);
  });
});
