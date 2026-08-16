import bcrypt from "bcrypt";
import { config } from "../config.js";

export async function hashSecret(plain: string): Promise<string> {
  return bcrypt.hash(plain, config.bcryptRounds);
}

export async function verifySecret(plain: string, hash: string): Promise<boolean> {
  return bcrypt.compare(plain, hash);
}
