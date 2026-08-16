import Database from "better-sqlite3";
import { registerMigration } from "../migrate.js";

registerMigration("001_create_users", (db: Database.Database) => {
  db.exec(`
    CREATE TABLE users (
      id            TEXT PRIMARY KEY NOT NULL,
      email         TEXT UNIQUE,
      password_hash TEXT NOT NULL,
      display_name  TEXT,
      created_at    TEXT NOT NULL,
      updated_at    TEXT NOT NULL,
      disabled_at   TEXT
    );
    CREATE INDEX idx_users_email ON users(email);
  `);
});
