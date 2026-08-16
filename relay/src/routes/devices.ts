import { Router, Request, Response, NextFunction } from "express";
import { z } from "zod";
import { asyncHandler } from "../lib/async-handler.js";
import { ok } from "../lib/response.js";
import * as deviceService from "../services/device-service.js";
import { authenticate } from "../middleware/authenticate.js";
import { ValidationError } from "../lib/errors.js";

const router = Router();

const createDeviceSchema = z.object({
  label: z.string().min(1).max(100),
  platform: z.enum(["windows", "android", "web", "other"]).optional().default("other"),
});

const registerDeviceSchema = z.object({
  label: z.string().min(1).max(100),
  platform: z.enum(["windows", "android", "web", "other"]),
  appVersion: z.string().max(50).optional(),
  clientDeviceKey: z.string().min(1).max(128).optional(),
});

router.use(authenticate);

router.get(
  "/devices",
  asyncHandler(async (req: Request, res: Response, _next: NextFunction) => {
    const devices = deviceService.list(req.userId!);
    ok(res, devices);
  })
);

router.post(
  "/devices",
  asyncHandler(async (req: Request, res: Response, _next: NextFunction) => {
    const body = createDeviceSchema.safeParse(req.body);
    if (!body.success) {
      throw new ValidationError(body.error.errors.map((e) => e.message).join("; "));
    }

    const device = deviceService.create(req.userId!, body.data.label);
    ok(res, device, 201);
  })
);

router.post(
  "/devices/register",
  asyncHandler(async (req: Request, res: Response, _next: NextFunction) => {
    const body = registerDeviceSchema.safeParse(req.body);
    if (!body.success) {
      throw new ValidationError(body.error.errors.map((e) => e.message).join("; "));
    }

    const result = await deviceService.register(req.userId!, {
      label: body.data.label,
      platform: body.data.platform,
      clientDeviceKey: body.data.clientDeviceKey,
    });
    ok(res, result, 201);
  })
);

router.get(
  "/devices/:deviceId",
  asyncHandler(async (req: Request, res: Response, _next: NextFunction) => {
    const device = deviceService.get(req.userId!, req.params.deviceId);
    ok(res, device);
  })
);

router.post(
  "/devices/:deviceId/revoke",
  asyncHandler(async (req: Request, res: Response, _next: NextFunction) => {
    deviceService.revoke(req.userId!, req.params.deviceId);
    ok(res, { message: "Device revoked" });
  })
);

export default router;
