import { Request, Response, NextFunction } from "express";
import { verifyAccessToken } from "../lib/jwt.js";
import { AuthError } from "../lib/errors.js";

export function authenticate(req: Request, _res: Response, next: NextFunction): void {
  const header = req.headers.authorization;
  if (!header || !header.startsWith("Bearer ")) {
    throw new AuthError("Missing or invalid authorization header", false);
  }

  const token = header.slice(7);
  try {
    const { userId } = verifyAccessToken(token);
    req.userId = userId;
    next();
  } catch (err: any) {
    const expired =
      err.name === "TokenExpiredError" || err.name === "JsonWebTokenError";
    throw new AuthError(
      expired ? "Token expired" : "Invalid token",
      expired
    );
  }
}
