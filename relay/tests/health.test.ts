import { describe, it, expect, beforeEach } from "vitest";
import { createTestApp } from "./helpers/setup.js";

describe("GET /health", () => {
  let request: ReturnType<typeof createTestApp>["request"];

  beforeEach(() => {
    const ctx = createTestApp();
    request = ctx.request;
  });

  it("returns 200 with status ok", async () => {
    const res = await request.get("/health");
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true, data: { status: "ok" } });
  });
});
