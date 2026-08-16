import Database from "better-sqlite3";
import { generateId } from "../../src/lib/id-generator.js";
import { hashSecret } from "../../src/lib/hash.js";
import { signAccessToken } from "../../src/lib/jwt.js";

export async function seedUser(
  db: Database.Database,
  usernameOrEmail: string,
  password: string
): Promise<{ user: any; accessToken: string }> {
  const now = new Date().toISOString();
  const id = generateId();
  const passwordHash = await hashSecret(password);

  const username = usernameOrEmail.includes("@") ? usernameOrEmail.split("@")[0] : usernameOrEmail;
  const email = usernameOrEmail.includes("@") ? usernameOrEmail : null;

  db.prepare(
    `INSERT INTO users (id, username, email, password_hash, display_name, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  ).run(id, username, email, passwordHash, username, now, now);

  const user = {
    id,
    username,
    email,
    password_hash: passwordHash,
    display_name: username,
    created_at: now,
    updated_at: now,
    disabled_at: null,
  };

  const accessToken = signAccessToken(id);

  return { user, accessToken };
}
