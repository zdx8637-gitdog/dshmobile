import { Router, Request, Response, NextFunction } from "express";
import { z } from "zod";
import { asyncHandler } from "../lib/async-handler.js";
import { ok } from "../lib/response.js";
import * as pairingService from "../services/pairing-service.js";
import { authenticate } from "../middleware/authenticate.js";
import { AuthError, ValidationError } from "../lib/errors.js";

/**
 * 扫码登录/授权的公开面。
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

// ---- S2：设备授权码流（插件未登录时的常驻二维码） ----

/** 匿名出码：插件未登录也能拿到「码 + 领取凭证」（只返回一次明文）。 */
router.post(
  "/pairing-codes/device",
  asyncHandler(async (_req: Request, res: Response) => {
    const result = pairingService.createDeviceCode();
    ok(
      res,
      {
        id: result.id,
        code: result.code,
        requestSecret: result.requestSecret,
        expiresAt: result.expiresAt,
      },
      201
    );
  })
);

/** 手机（已登录）扫码授权：绑定账号到设备授权码。 */
router.post(
  "/pairing-codes/:pairingCodeId/grant",
  authenticate,
  asyncHandler(async (req: Request, res: Response) => {
    pairingService.grant(req.userId!, req.params.pairingCodeId);
    ok(res, { message: "Granted" });
  })
);

/** 插件轮询：凭 requestSecret 取授权状态（授予后一次性签发会话）。 */
router.get(
  "/pairing-codes/:pairingCodeId/status",
  asyncHandler(async (req: Request, res: Response) => {
    const secret = String(req.query.secret ?? "");
    if (!secret) throw new ValidationError("missing secret");
    const result = await pairingService.pollStatus(req.params.pairingCodeId, secret);
    if (result.status === "pending") {
      ok(res, { status: "pending" });
      return;
    }
    ok(res, {
      status: "granted",
      accessToken: result.accessToken,
      refreshToken: result.refreshToken,
      user: result.user,
    });
  })
);

export default router;
