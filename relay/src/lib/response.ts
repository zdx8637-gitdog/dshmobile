import { Response } from "express";

export function ok<T>(res: Response, data: T, statusCode: number = 200) {
  return res.status(statusCode).json({ ok: true, data });
}

export function fail(
  res: Response,
  statusCode: number,
  code: string,
  message: string,
  retriable: boolean = false
) {
  return res.status(statusCode).json({
    ok: false,
    error: { code, message, retriable },
  });
}
