import { initDb } from "./db/connection.js";
import { runMigrations } from "./db/migrate.js";
import { generateId } from "./lib/id-generator.js";
import { hashSecret } from "./lib/hash.js";
import { logger } from "./lib/logger.js";

// Import migrations
import "./db/migrations/001_create_users.js";
import "./db/migrations/002_create_auth_sessions.js";
import "./db/migrations/003_create_devices.js";
import "./db/migrations/004_create_pairing_codes.js";
import "./db/migrations/005_create_audit_logs.js";

async function seed() {
  const db = initDb();
  runMigrations(db);

  const email = process.env.SEED_EMAIL ?? "admin@example.com";
  const password = process.env.SEED_PASSWORD ?? "admin123";

  const now = new Date().toISOString();
  const id = generateId();
  const passwordHash = await hashSecret(password);

  const existing = db.prepare("SELECT id FROM users WHERE email = ?").get(email);
  if (existing) {
    logger.info({ email }, "User already exists, skipping seed");
    process.exit(0);
  }

  db.prepare(
    `INSERT INTO users (id, email, password_hash, display_name, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?)`
  ).run(id, email, passwordHash, "Admin", now, now);

  logger.info({ email, id }, "Seed user created");
  process.exit(0);
}

seed().catch((err) => {
  logger.error({ err }, "Seed failed");
  process.exit(1);
});
