import { Router, Request, Response } from "express";
import { ok } from "../lib/response.js";
import { relayManager } from "../ws/relay.js";

const router = Router();

router.get("/health", (_req: Request, res: Response) => {
  ok(res, { status: "ok" });
});

router.get("/relay/status", (_req: Request, res: Response) => {
  ok(res, relayManager.getStats());
});

export default router;
