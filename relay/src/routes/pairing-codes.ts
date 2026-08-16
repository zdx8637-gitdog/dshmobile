import { Router, Request, Response, NextFunction } from "express";
import { asyncHandler } from "../lib/async-handler.js";
import { ok } from "../lib/response.js";
import * as pairingService from "../services/pairing-service.js";
import { authenticate } from "../middleware/authenticate.js";

const router = Router();

router.use(authenticate);

router.post(
  "/pairing-codes",
  asyncHandler(async (req: Request, res: Response, _next: NextFunction) => {
    const result = await pairingService.create(req.userId!);
    ok(res, result, 201);
  })
);

router.get(
  "/pairing-codes",
  asyncHandler(async (req: Request, res: Response, _next: NextFunction) => {
    const codes = pairingService.list(req.userId!);
    ok(res, codes);
  })
);

router.post(
  "/pairing-codes/:pairingCodeId/cancel",
  asyncHandler(async (req: Request, res: Response, _next: NextFunction) => {
    pairingService.cancel(req.userId!, req.params.pairingCodeId);
    ok(res, { message: "Pairing code cancelled" });
  })
);

export default router;
