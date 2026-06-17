import { Router } from 'express';
import { z } from 'zod';
import type { Role, User } from '@prisma/client';
import { prisma } from '../../lib/prisma';
import { asyncHandler, badRequest, notFound } from '../../lib/errors';
import { parse } from '../../lib/validate';
import { requireAdmin } from '../../auth/middleware';

/** Mounted at /api/admin. Every route here is admin-only. */
const router = Router();

// Admin gating, in addition to the global requireAuth applied upstream.
router.use(requireAdmin);

interface SerializedUser {
  id: string;
  name: string;
  email: string;
  avatarUrl: string | null;
  role: Role;
  createdAt: string;
}

/** Wire shape of a user (matches the client `User` type). */
function serializeUser(u: User): SerializedUser {
  return {
    id: u.id,
    name: u.name,
    email: u.email,
    avatarUrl: u.avatarUrl,
    role: u.role,
    createdAt: u.createdAt.toISOString(),
  };
}

const roleSchema = z.object({
  role: z.enum(['USER', 'ADMIN']),
});

/** GET /api/admin/users — every user, oldest first. */
router.get(
  '/users',
  asyncHandler(async (_req, res) => {
    const users = await prisma.user.findMany({ orderBy: { createdAt: 'asc' } });
    res.json({ users: users.map(serializeUser) });
  }),
);

/** PATCH /api/admin/users/:id/role — change a user's role. */
router.patch(
  '/users/:id/role',
  asyncHandler(async (req, res) => {
    const { id } = req.params;
    const { role } = parse(roleSchema, req.body);

    const target = await prisma.user.findUnique({ where: { id } });
    if (!target) throw notFound('User not found');

    // Prevent an admin from removing their own admin role and locking themselves out.
    if (id === req.user!.id && role !== 'ADMIN') {
      throw badRequest('You cannot remove your own admin role');
    }

    const user = await prisma.user.update({ where: { id }, data: { role } });
    res.json({ user: serializeUser(user) });
  }),
);

export default router;
