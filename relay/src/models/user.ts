import { getDb } from "../db/connection.js";
import { generateId } from "../lib/id-generator.js";
import type { User } from "../types/entities.js";

export function createUser(params: {
  username?: string | null;
  email?: string | null;
  passwordHash: string;
  displayName?: string | null;
}): User {
  const db = getDb();
  const now = new Date().toISOString();
  const id = generateId();

  db.prepare(
    `INSERT INTO users (id, username, email, password_hash, display_name, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  ).run(
    id,
    params.username ?? null,
    params.email ?? null,
    params.passwordHash,
    params.displayName ?? null,
    now,
    now
  );

  return {
    id,
    username: params.username ?? null,
    email: params.email ?? null,
    password_hash: params.passwordHash,
    display_name: params.displayName ?? null,
    created_at: now,
    updated_at: now,
    disabled_at: null,
  };
}

export function findByUsername(username: string): User | undefined {
  const db = getDb();
  return db.prepare("SELECT * FROM users WHERE username = ?").get(username) as User | undefined;
}

export function findByEmail(email: string | null): User | undefined {
  const db = getDb();
  return db.prepare("SELECT * FROM users WHERE email = ?").get(email) as User | undefined;
}

export function findById(id: string): User | undefined {
  const db = getDb();
  return db.prepare("SELECT * FROM users WHERE id = ?").get(id) as User | undefined;
}

export function disableUser(id: string): void {
  const db = getDb();
  const now = new Date().toISOString();
  db.prepare("UPDATE users SET disabled_at = ?, updated_at = ? WHERE id = ?").run(now, now, id);
}
