import Database from "better-sqlite3";
import { registerMigration } from "../migrate.js";

registerMigration("004_create_pairing_codes", (db: Database.Database) => {
  db.exec(`
    CREATE TABLE pairing_codes (
      id         TEXT PRIMARY KEY NOT NULL,
      user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      code_hash  TEXT NOT NULL UNIQUE,
      expires_at TEXT NOT NULL,
      used_at    TEXT,
      device_id  TEXT REFERENCES devices(id),
      created_at TEXT NOT NULL
    );
    CREATE INDEX idx_pairing_codes_user_id ON pairing_codes(user_id);
  `);
});
