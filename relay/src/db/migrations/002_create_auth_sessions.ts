import Database from "better-sqlite3";
import { registerMigration } from "../migrate.js";

registerMigration("002_create_auth_sessions", (db: Database.Database) => {
  db.exec(`
    CREATE TABLE auth_sessions (
      id                  TEXT PRIMARY KEY NOT NULL,
      user_id             TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      refresh_token_hash  TEXT NOT NULL UNIQUE,
      created_at          TEXT NOT NULL,
      expires_at          TEXT NOT NULL,
      revoked_at          TEXT
    );
    CREATE INDEX idx_auth_sessions_user_id ON auth_sessions(user_id);
    CREATE INDEX idx_auth_sessions_refresh_hash ON auth_sessions(refresh_token_hash);
  `);
});
