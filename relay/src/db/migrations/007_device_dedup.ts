
import Database from "better-sqlite3";
import { registerMigration } from "../migrate.js";

registerMigration("007_device_dedup", (db: Database.Database) => {
  db.exec(`
    ALTER TABLE devices ADD COLUMN client_device_key TEXT;
    CREATE UNIQUE INDEX idx_devices_user_platform_key
      ON devices(user_id, platform, client_device_key)
      WHERE client_device_key IS NOT NULL AND revoked_at IS NULL;
  `);
});

