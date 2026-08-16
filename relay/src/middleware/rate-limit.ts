import { Request, Response, NextFunction } from "express";
import { RateLimiter } from "../lib/rate-limiter.js";
import { RateLimitError } from "../lib/errors.js";

export function rateLimit(limiter: RateLimiter, keyFn?: (req: Request) => string) {
  return (req: Request, _res: Response, next: NextFunction): void => {
    const key = keyFn ? keyFn(req) : req.ip ?? "unknown";
    if (!limiter.allow(key)) {
      throw new RateLimitError();
    }
    next();
  };
}
