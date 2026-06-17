import jwt from 'jsonwebtoken';
import type { Response } from 'express';
import { env } from '../config/env';

export const SESSION_COOKIE = 'cb_session';

/** Sign a session JWT for the user and set it as a secure, HTTP-only cookie. */
export function issueSession(res: Response, userId: string): void {
  const token = jwt.sign({ sub: userId }, env.SESSION_SECRET, {
    expiresIn: `${env.SESSION_TTL_DAYS}d`,
  });
  res.cookie(SESSION_COOKIE, token, {
    httpOnly: true,
    secure: env.cookieSecure,
    sameSite: 'lax',
    maxAge: env.SESSION_TTL_DAYS * 24 * 60 * 60 * 1000,
    path: '/',
  });
}

export function clearSession(res: Response): void {
  res.clearCookie(SESSION_COOKIE, { path: '/' });
}

/** Verify a session token and return the user id, or null if invalid/expired. */
export function readSession(token: string | undefined): string | null {
  if (!token) return null;
  try {
    const payload = jwt.verify(token, env.SESSION_SECRET) as { sub?: string };
    return payload.sub ?? null;
  } catch {
    return null;
  }
}
