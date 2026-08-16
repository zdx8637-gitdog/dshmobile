import Database from "better-sqlite3";
import { runMigrations } from "../../src/db/migrate.js";
import { setTestDb } from "../../src/db/connection.js";
import { createApp } from "../../src/app.js";
import supertest from "supertest";

// Register migrations before anything else
import "../../src/db/migrations/001_create_users.js";
import "../../src/db/migrations/002_create_auth_sessions.js";
import "../../src/db/migrations/003_create_devices.js";
import "../../src/db/migrations/004_create_pairing_codes.js";
import "../../src/db/migrations/005_create_audit_logs.js";
import "../../src/db/migrations/006_add_username_device_tokens.js";

export function createTestApp() {
  const db = new Database(":memory:");
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  runMigrations(db);

  // Inject the test DB so models use it
  setTestDb(db);

  const app = createApp(db);

  const request = supertest(app);

  return { db, app, request };
}
