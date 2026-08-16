import { Router, Request, Response, NextFunction } from "express";
import { z } from "zod";
import { asyncHandler } from "../lib/async-handler.js";
import { ok } from "../lib/response.js";
import * as pairingService from "../services/pairing-service.js";
import { AuthError, ValidationError } from "../lib/errors.js";

/**
 * 扫码登录核销（方向一）：无登录态的公开入口。
 * 独立成路由器并挂载在其它带 authenticate 的路由器之前——
 * 其它路由器的 router.use(authenticate) 是无路径中间件，会匹配所有经过的请求。
 */
const router = Router();

const verifySchema = z.object({
  code: z.string().min(1).max(20),
});

router.post(
  "/pairing-codes/verify",
  asyncHandler(async (req: Request, res: Response, _next: NextFunction) => {
    const body = verifySchema.safeParse(req.body);
    if (!body.success) {
      throw new ValidationError(body.error.errors.map((e) => e.message).join("; "));
    }

    try {
      const result = await pairingService.verify(body.data.code, req.ip);
      ok(res, {
        accessToken: result.accessToken,
        refreshToken: result.refreshToken,
        user: {
          id: result.userId,
          username: result.username,
        },
      });
    } catch (err) {
      if (err instanceof AuthError) throw err;
      throw err;
    }
  })
);

export default router;
