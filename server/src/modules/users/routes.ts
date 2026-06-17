import { Router } from 'express';
import { prisma } from '../../lib/prisma';
import { asyncHandler } from '../../lib/errors';

/** Mounted at /api/users — compact directory for pickers (e.g. ownership transfer). */
const router = Router();

/** GET /api/users — all users as UserSummary, for pickers. */
router.get(
  '/',
  asyncHandler(async (_req, res) => {
    const users = await prisma.user.findMany({
      orderBy: { name: 'asc' },
      select: { id: true, name: true, email: true, avatarUrl: true },
    });
    res.json({ users });
  }),
);

export default router;
