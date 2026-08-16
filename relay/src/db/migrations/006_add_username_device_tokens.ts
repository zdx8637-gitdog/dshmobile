import Database from "better-sqlite3";
import { registerMigration } from "../migrate.js";

registerMigration("006_add_username_device_tokens", (db: Database.Database) => {
  // Add username column to users (nullable for existing rows, will be enforced at app layer)
  db.exec(`ALTER TABLE users ADD COLUMN username TEXT;`);
  db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS idx_users_username ON users(username);`);

  // Add platform column to devices
  db.exec(`ALTER TABLE devices ADD COLUMN platform TEXT DEFAULT 'other';`);

  // Create device_tokens table
  db.exec(`
    CREATE TABLE device_tokens (
      id            TEXT PRIMARY KEY NOT NULL,
      device_id     TEXT NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
      user_id       TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      token_hash    TEXT NOT NULL,
      created_at    TEXT NOT NULL,
      expires_at    TEXT,
      revoked_at    TEXT
    );
    CREATE INDEX idx_device_tokens_device_id ON device_tokens(device_id);
    CREATE INDEX idx_device_tokens_user_id ON device_tokens(user_id);
  `);

  // Create relay_connections table for connection logging
  db.exec(`
    CREATE TABLE relay_connections (
      id            TEXT PRIMARY KEY NOT NULL,
      user_id       TEXT,
      device_id     TEXT,
      client_id     TEXT,
      direction     TEXT NOT NULL CHECK (direction IN ('bridge','client')),
      connected_at  TEXT NOT NULL,
      disconnected_at TEXT
    );
  `);
});
