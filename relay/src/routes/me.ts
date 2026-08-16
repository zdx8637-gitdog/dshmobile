import { Router, Request, Response, NextFunction } from "express";
import { asyncHandler } from "../lib/async-handler.js";
import { ok } from "../lib/response.js";
import * as userModel from "../models/user.js";
import { authenticate } from "../middleware/authenticate.js";
import { NotFoundError } from "../lib/errors.js";

const router = Router();

router.get(
  "/me",
  authenticate,
  asyncHandler(async (req: Request, res: Response, _next: NextFunction) => {
    const user = userModel.findById(req.userId!);
    if (!user) throw new NotFoundError("User not found");

    ok(res, {
      id: user.id,
      username: user.username,
      email: user.email,
      displayName: user.display_name,
      createdAt: user.created_at,
    });
  })
);

export default router;
