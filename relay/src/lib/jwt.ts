import jwt from "jsonwebtoken";
import { config } from "../config.js";

export function signAccessToken(userId: string): string {
  return jwt.sign({ sub: userId, scope: "client" }, config.jwtSecret, {
    expiresIn: config.accessTokenTTL,
  });
}

export function verifyAccessToken(token: string): { userId: string } {
  const payload = jwt.verify(token, config.jwtSecret) as jwt.JwtPayload;
  if (payload.scope !== "client") throw new Error("invalid token scope");
  return { userId: payload.sub! };
}

export function signDeviceToken(deviceId: string, userId: string): string {
  return jwt.sign(
    { sub: deviceId, userId, scope: "device" },
    config.jwtSecret,
    { expiresIn: config.deviceTokenTTL }
  );
}

export function verifyDeviceToken(token: string): { deviceId: string; userId: string } {
  const payload = jwt.verify(token, config.jwtSecret) as jwt.JwtPayload;
  if (payload.scope !== "device") throw new Error("invalid token scope");
  return { deviceId: payload.sub!, userId: payload.userId };
}
