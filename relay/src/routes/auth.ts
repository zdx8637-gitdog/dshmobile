import { Router, Request, Response, NextFunction } from "express";
import { z } from "zod";
import { asyncHandler } from "../lib/async-handler.js";
import { ok, fail } from "../lib/response.js";
import * as authService from "../services/auth-service.js";
import * as deviceModel from "../models/device.js";
import { AuthError, ValidationError } from "../lib/errors.js";

const router = Router();

const registerSchema = z.object({
  username: z.string().min(3).max(50).regex(/^[a-zA-Z0-9_-]+$/, "Username must be alphanumeric"),
  password: z.string().min(6).max(128),
  displayName: z.string().max(100).optional(),
});

const loginSchema = z.object({
  username: z.string().optional(),
  email: z.string().optional(),
  password: z.string().min(1),
}).refine((d) => d.username || d.email, "username or email is required");

const tokenSchema = z.object({
  refreshToken: z.string().min(1),
});

router.post(
  "/auth/register",
  asyncHandler(async (req: Request, res: Response, _next: NextFunction) => {
    const body = registerSchema.safeParse(req.body);
    if (!body.success) {
      throw new ValidationError(body.error.errors.map((e) => e.message).join("; "));
    }

    const result = await authService.register(
      body.data.username,
      body.data.password,
      body.data.displayName
    );
    ok(res, { id: result.userId, username: result.username }, 201);
  })
);


function toDeviceSummary(d: any) {
  return {
    id: d.id,
    label: d.label,
    platform: d.platform ?? "other",
    status: d.status,
    createdAt: d.created_at,
    lastSeenAt: d.last_seen_at,
  };
}

router.post(
  "/auth/login",
  asyncHandler(async (req: Request, res: Response, _next: NextFunction) => {
    const body = loginSchema.safeParse(req.body);
    if (!body.success) {
      throw new ValidationError(body.error.errors.map((e) => e.message).join("; "));
    }

    const credential = body.data.username || body.data.email!;
    const { password } = body.data;

    try {
      const result = await authService.login(credential, password, req.ip);
      const devices = deviceModel.listByUser(result.userId).map(toDeviceSummary);
      ok(res, {
        accessToken: result.accessToken,
        refreshToken: result.refreshToken,
        user: {
          id: result.userId,
          username: result.username,
        },
        devices,
      });
    } catch (err) {
      if (err instanceof AuthError) throw err;
      throw err;
    }
  })
);

router.post(
  "/auth/refresh",
  asyncHandler(async (req: Request, res: Response, _next: NextFunction) => {
    const body = tokenSchema.safeParse(req.body);
    if (!body.success) {
      throw new ValidationError(body.error.errors.map((e) => e.message).join("; "));
    }

    try {
      const result = await authService.refresh(body.data.refreshToken);
      ok(res, {
        accessToken: result.accessToken,
        refreshToken: result.refreshToken,
      });
    } catch (err) {
      if (err instanceof AuthError) throw err;
      throw err;
    }
  })
);

router.post(
  "/auth/logout",
  asyncHandler(async (req: Request, res: Response, _next: NextFunction) => {
    const body = tokenSchema.safeParse(req.body);
    if (!body.success) {
      throw new ValidationError(body.error.errors.map((e) => e.message).join("; "));
    }

    await authService.logout(body.data.refreshToken);
    ok(res, { message: "Logged out" });
  })
);

export default router;
