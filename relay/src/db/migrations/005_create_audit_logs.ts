import Database from "better-sqlite3";
import { registerMigration } from "../migrate.js";

registerMigration("005_create_audit_logs", (db: Database.Database) => {
  db.exec(`
    CREATE TABLE audit_logs (
      id          TEXT PRIMARY KEY NOT NULL,
      user_id     TEXT,
      device_id   TEXT,
      action      TEXT NOT NULL,
      target_type TEXT NOT NULL,
      target_id   TEXT,
      ip_hash     TEXT,
      created_at  TEXT NOT NULL
    );
    CREATE INDEX idx_audit_logs_user_id ON audit_logs(user_id);
    CREATE INDEX idx_audit_logs_action ON audit_logs(action);
    CREATE INDEX idx_audit_logs_created_at ON audit_logs(created_at);
  `);
});
