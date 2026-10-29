import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";
import { config } from "../config";

export const hashPassword = (pw: string) => bcrypt.hash(pw, config.isTest ? 4 : 10);
export const verifyPassword = (pw: string, hash: string) => bcrypt.compare(pw, hash);

const ALG = "HS256" as const;

/** `tv` = the user's tokenVersion; bumping it (logout-all) invalidates every older token. */
export function signToken(userId: string, tokenVersion = 0): string {
  return jwt.sign({ sub: userId, tv: tokenVersion }, config.jwtSecret, {
    algorithm: ALG,
    expiresIn: config.jwtExpiresIn,
  } as jwt.SignOptions);
}

export function verifyToken(token: string): { userId: string; tokenVersion: number } | null {
  try {
    const payload = jwt.verify(token, config.jwtSecret, { algorithms: [ALG] });
    if (typeof payload !== "object" || typeof payload.sub !== "string") return null;
    const tv = (payload as { tv?: unknown }).tv;
    return { userId: payload.sub, tokenVersion: typeof tv === "number" ? tv : 0 };
  } catch {
    return null;
  }
}
