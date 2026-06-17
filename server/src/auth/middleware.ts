import type { NextFunction, Request, Response } from 'express';
import type { Role } from '@prisma/client';
import { prisma } from '../lib/prisma';
import { forbidden, unauthorized } from '../lib/errors';
import { SESSION_COOKIE, readSession } from './session';
import { resolveIapUser } from './iap';

export interface AuthedUser {
  id: string;
  email: string;
  name: string;
  avatarUrl: string | null;
  role: Role;
}

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      user?: AuthedUser;
    }
  }
}

/** Resolve the current user from IAP (production) or the session cookie. Never throws. */
export async function loadUser(req: Request): Promise<AuthedUser | null> {
  // Behind IAP, the verified edge identity wins — no app cookie needed.
  const iapUser = await resolveIapUser(req);
  if (iapUser) return iapUser;

  const userId = readSession(req.cookies?.[SESSION_COOKIE]);
  if (!userId) return null;
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { id: true, email: true, name: true, avatarUrl: true, role: true },
  });
  return user;
}

/** Require a valid session; attaches req.user or responds 401. */
export async function requireAuth(req: Request, _res: Response, next: NextFunction): Promise<void> {
  try {
    const user = await loadUser(req);
    if (!user) throw unauthorized();
    req.user = user;
    next();
  } catch (err) {
    next(err);
  }
}

/** Require an authenticated ADMIN; must run after requireAuth (or standalone). */
export async function requireAdmin(req: Request, _res: Response, next: NextFunction): Promise<void> {
  try {
    const user = req.user ?? (await loadUser(req));
    if (!user) throw unauthorized();
    if (user.role !== 'ADMIN') throw forbidden('Admin access required');
    req.user = user;
    next();
  } catch (err) {
    next(err);
  }
}
