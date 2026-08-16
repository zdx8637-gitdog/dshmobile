import Database from "better-sqlite3";
import { registerMigration } from "../migrate.js";

registerMigration("008_indexed_refresh_tokens", (db: Database.Database) => {
  db.exec(`
    ALTER TABLE auth_sessions ADD COLUMN token_selector TEXT;
    ALTER TABLE auth_sessions ADD COLUMN token_secret_hash TEXT;
    CREATE UNIQUE INDEX idx_auth_sessions_token_selector
      ON auth_sessions(token_selector);
  `);
});
