import type { RequestHandler, Request } from "express";
import { isValidObjectId } from "mongoose";
import { UserModel, type UserDoc } from "../models/User";
import { HttpError } from "../errors";
import { verifyToken } from "../services/auth";
import { resolveTimezone } from "../services/dates";
import { config } from "../config";

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      user?: UserDoc;
      userId?: string;
    }
  }
}

export const requireAuth: RequestHandler = (req, _res, next) => {
  const header = req.headers.authorization ?? "";
  const m = /^Bearer\s+(.+)$/i.exec(header);
  if (!m) return next(new HttpError(401, "UNAUTHORIZED", "Missing bearer token"));
  const userId = verifyToken(m[1].trim());
  if (!userId || !isValidObjectId(userId)) return next(new HttpError(401, "UNAUTHORIZED", "Invalid or expired token"));
  UserModel.findById(userId)
    .then((user) => {
      if (!user) return next(new HttpError(401, "UNAUTHORIZED", "User no longer exists"));
      req.user = user;
      req.userId = user._id.toString();
      next();
    })
    .catch(next);
};

/** Authenticated user id (requireAuth must run first). */
export function uid(req: Request): string {
  if (!req.userId) throw new HttpError(401, "UNAUTHORIZED", "Not authenticated");
  return req.userId;
}

/** Optional client timezone via `X-Timezone` header or `?tz=` (not in the contract; default Asia/Kolkata). */
export function reqTimezone(req: Request): string {
  const q = typeof req.query.tz === "string" ? req.query.tz : undefined;
  const h = req.get("x-timezone") ?? undefined;
  return resolveTimezone(q ?? h, config.defaultTimezone);
}
