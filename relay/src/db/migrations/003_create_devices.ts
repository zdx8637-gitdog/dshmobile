import Database from "better-sqlite3";
import { registerMigration } from "../migrate.js";

registerMigration("003_create_devices", (db: Database.Database) => {
  db.exec(`
    CREATE TABLE devices (
      id           TEXT PRIMARY KEY NOT NULL,
      user_id      TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      label        TEXT NOT NULL,
      status       TEXT NOT NULL CHECK (status IN ('offline','online')) DEFAULT 'offline',
      created_at   TEXT NOT NULL,
      paired_at    TEXT,
      last_seen_at TEXT,
      revoked_at   TEXT
    );
    CREATE INDEX idx_devices_user_id ON devices(user_id);
  `);
});
