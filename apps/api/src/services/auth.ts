import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";
import { config } from "../config";

export const hashPassword = (pw: string) => bcrypt.hash(pw, config.isTest ? 4 : 10);
export const verifyPassword = (pw: string, hash: string) => bcrypt.compare(pw, hash);

export function signToken(userId: string): string {
  return jwt.sign({ sub: userId }, config.jwtSecret, { expiresIn: config.jwtExpiresIn } as jwt.SignOptions);
}

export function verifyToken(token: string): string | null {
  try {
    const payload = jwt.verify(token, config.jwtSecret);
    if (typeof payload === "object" && typeof payload.sub === "string") return payload.sub;
    return null;
  } catch {
    return null;
  }
}
