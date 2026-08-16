import { Request, Response, NextFunction } from "express";
import { logger } from "../lib/logger.js";

export function requestLogger(req: Request, res: Response, next: NextFunction): void {
  const start = Date.now();

  res.on("finish", () => {
    logger.info(
      {
        method: req.method,
        path: req.path,
        status: res.statusCode,
        duration: Date.now() - start,
        ip: req.ip,
      },
      `${req.method} ${req.path} ${res.statusCode}`
    );
  });

  next();
}
