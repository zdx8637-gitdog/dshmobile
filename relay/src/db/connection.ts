import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import { config } from "../config.js";

let db: Database.Database | null = null;

export function initDb(dbPath?: string): Database.Database {
  const resolvedPath = dbPath ?? config.dbPath;

  // Ensure parent directory exists for file-based databases
  if (resolvedPath !== ":memory:") {
    const dir = path.dirname(resolvedPath);
    fs.mkdirSync(dir, { recursive: true });
  }

  db = new Database(resolvedPath);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  return db;
}

export function getDb(): Database.Database {
  if (!db) {
    return initDb();
  }
  return db;
}

/** Only for tests — inject a test database */
export function setTestDb(testDb: Database.Database): void {
  db = testDb;
}

export function closeDb(): void {
  if (db) {
    db.close();
    db = null;
  }
}
