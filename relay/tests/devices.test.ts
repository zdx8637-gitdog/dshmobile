import { describe, it, expect, beforeEach } from "vitest";
import { createTestApp } from "./helpers/setup.js";
import { seedUser } from "./helpers/seed.js";

describe("Devices CRUD", () => {
  let request: ReturnType<typeof createTestApp>["request"];
  let accessToken: string;

  beforeEach(async () => {
    const ctx = createTestApp();
    request = ctx.request;
    const { accessToken: token } = await seedUser(ctx.db, "test@example.com", "password123");
    accessToken = token;
  });

  it("lists devices (empty initially)", async () => {
    const res = await request
      .get("/devices")
      .set("Authorization", `Bearer ${accessToken}`);

    expect(res.status).toBe(200);
    expect(res.body.data).toEqual([]);
  });

  it("creates a device", async () => {
    const res = await request
      .post("/devices")
      .set("Authorization", `Bearer ${accessToken}`)
      .send({ label: "My Device" });

    expect(res.status).toBe(201);
    expect(res.body.data.label).toBe("My Device");
    expect(res.body.data.id).toBeDefined();
    expect(res.body.data.status).toBe("offline");
  });

  it("gets a device by id", async () => {
    const create = await request
      .post("/devices")
      .set("Authorization", `Bearer ${accessToken}`)
      .send({ label: "My Device" });

    const res = await request
      .get(`/devices/${create.body.data.id}`)
      .set("Authorization", `Bearer ${accessToken}`);

    expect(res.status).toBe(200);
    expect(res.body.data.label).toBe("My Device");
  });

  it("revokes a device", async () => {
    const create = await request
      .post("/devices")
      .set("Authorization", `Bearer ${accessToken}`)
      .send({ label: "My Device" });

    const res = await request
      .post(`/devices/${create.body.data.id}/revoke`)
      .set("Authorization", `Bearer ${accessToken}`);

    expect(res.status).toBe(200);

    // 吊销后从列表消失（软删除过滤，见 D6/F23）
    const list = await request
      .get("/devices")
      .set("Authorization", `Bearer ${accessToken}`);
    const revoked = list.body.data.find((d: any) => d.id === create.body.data.id);
    expect(revoked).toBeUndefined();

    // 单查仍可见且带 revokedAt（审计可查）
    const single = await request
      .get(`/devices/${create.body.data.id}`)
      .set("Authorization", `Bearer ${accessToken}`);
    expect(single.status).toBe(200);
    expect(single.body.data.revokedAt).toBeDefined();
  });

  it("returns 404 for non-existent device", async () => {
    const res = await request
      .get("/devices/nonexistent-id")
      .set("Authorization", `Bearer ${accessToken}`);

    expect(res.status).toBe(404);
  });
});
