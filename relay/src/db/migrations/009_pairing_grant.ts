import Database from "better-sqlite3";
import { registerMigration } from "../migrate.js";

// 009：配对码支持"设备授权码流"（S2，RFC 8628）：
//   - user_id 改为可空（匿名出码：插件未登录时由 /pairing-codes/device 创建）；
//   - request_secret_hash：领取凭证哈希（只有持码方轮询能取走授予结果）；
//   - granted_to_user_id：手机（已登录）扫码授权后绑定的账号。
registerMigration("009_pairing_grant", (db: Database.Database) => {
  db.exec(`
    CREATE TABLE pairing_codes_new (
      id                  TEXT PRIMARY KEY NOT NULL,
      user_id             TEXT REFERENCES users(id) ON DELETE CASCADE,
      code_hash           TEXT NOT NULL UNIQUE,
      expires_at          TEXT NOT NULL,
      used_at             TEXT,
      device_id           TEXT REFERENCES devices(id),
      created_at          TEXT NOT NULL,
      request_secret_hash TEXT,
      granted_to_user_id  TEXT REFERENCES users(id)
    );
    INSERT INTO pairing_codes_new (id, user_id, code_hash, expires_at, used_at, device_id, created_at)
      SELECT id, user_id, code_hash, expires_at, used_at, device_id, created_at FROM pairing_codes;
    DROP TABLE pairing_codes;
    ALTER TABLE pairing_codes_new RENAME TO pairing_codes;
    CREATE INDEX idx_pairing_codes_user_id ON pairing_codes(user_id);
  `);
});
