import { describe, it, expect, beforeEach, afterEach } from "vitest";
import Database from "better-sqlite3";
import { runMigrations } from "../src/db/migrate.js";

// Register migrations
import "../src/db/migrations/001_create_users.js";
import "../src/db/migrations/002_create_auth_sessions.js";
import "../src/db/migrations/003_create_devices.js";
import "../src/db/migrations/004_create_pairing_codes.js";
import "../src/db/migrations/005_create_audit_logs.js";

describe("Migrations", () => {
  let db: Database.Database;

  beforeEach(() => {
    db = new Database(":memory:");
  });

  afterEach(() => {
    db.close();
  });

  it("creates all tables on first run", () => {
    runMigrations(db);

    const tables = db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")
      .all()
      .map((r: any) => r.name);

    expect(tables).toContain("users");
    expect(tables).toContain("auth_sessions");
    expect(tables).toContain("devices");
    expect(tables).toContain("pairing_codes");
    expect(tables).toContain("audit_logs");
    expect(tables).toContain("_migrations");
  });

  it("records applied migrations in _migrations", () => {
    runMigrations(db);

    const rows = db.prepare("SELECT name FROM _migrations ORDER BY name").all() as any[];
    const names = rows.map((r: any) => r.name);

    expect(names).toContain("001_create_users");
    expect(names).toContain("002_create_auth_sessions");
    expect(names).toContain("003_create_devices");
    expect(names).toContain("004_create_pairing_codes");
    expect(names).toContain("005_create_audit_logs");
  });

  it("is idempotent — running twice does not fail", () => {
    runMigrations(db);
    runMigrations(db); // Should not throw

    const rows = db.prepare("SELECT COUNT(*) as count FROM _migrations").get() as any;
    // Each migration should appear only once
    expect(rows.count).toBe(5);
  });
});
