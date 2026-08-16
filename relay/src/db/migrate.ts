import Database from "better-sqlite3";
import { logger } from "../lib/logger.js";

interface Migration {
  name: string;
  up: (db: Database.Database) => void;
}

const migrations: Migration[] = [];

export function registerMigration(name: string, up: (db: Database.Database) => void): void {
  migrations.push({ name, up });
}

export function getRegisteredMigrations(): Migration[] {
  return [...migrations];
}

export function runMigrations(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS _migrations (
      name TEXT PRIMARY KEY NOT NULL,
      applied_at TEXT NOT NULL
    );
  `);

  const applied = new Set(
    db
      .prepare("SELECT name FROM _migrations")
      .all()
      .map((r: any) => r.name)
  );

  for (const migration of migrations) {
    if (applied.has(migration.name)) continue;

    logger.info({ migration: migration.name }, "Applying migration");
    migration.up(db);

    db.prepare("INSERT INTO _migrations (name, applied_at) VALUES (?, ?)").run(
      migration.name,
      new Date().toISOString()
    );
    logger.info({ migration: migration.name }, "Migration applied");
  }
}
