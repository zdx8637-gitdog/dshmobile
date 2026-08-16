import { Request, Response, NextFunction } from "express";
import { ZodError } from "zod";
import { AppError } from "../lib/errors.js";
import { fail } from "../lib/response.js";
import { logger } from "../lib/logger.js";

export function errorHandler(
  err: Error,
  _req: Request,
  res: Response,
  _next: NextFunction
): void {
  if (err instanceof AppError) {
    fail(res, err.statusCode, err.code, err.message, err.retriable);
    return;
  }

  if (err instanceof ZodError) {
    fail(res, 400, "VALIDATION_ERROR", err.errors.map((e) => e.message).join("; "), false);
    return;
  }

  logger.error({ err }, "Unexpected error");
  fail(res, 500, "INTERNAL_ERROR", "An unexpected error occurred", false);
}
