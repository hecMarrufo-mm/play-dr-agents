import { Router } from 'express';
import { z } from 'zod';
import { prisma } from '../../lib/prisma';
import { asyncHandler } from '../../lib/errors';
import { parse } from '../../lib/validate';

/**
 * Mounted at /api/messages — cross-agent helpers that aren't scoped to a single
 * agent thread. Used to hydrate messages picked as context from other agents.
 */
const router = Router();

const resolveSchema = z.object({ ids: z.array(z.string()).max(200) });

const authorSelect = { id: true, name: true, email: true, avatarUrl: true } as const;

/** POST /api/messages/resolve — fetch arbitrary messages (any agent) for the context tray. */
router.post(
  '/resolve',
  asyncHandler(async (req, res) => {
    const { ids } = parse(resolveSchema, req.body);
    if (ids.length === 0) {
      res.json({ messages: [] });
      return;
    }
    const messages = await prisma.message.findMany({
      where: { id: { in: ids } },
      orderBy: { createdAt: 'asc' },
      include: { author: { select: authorSelect }, agent: { select: { id: true, title: true } } },
    });
    res.json({
      messages: messages.map((m) => ({
        id: m.id,
        agentId: m.agentId,
        agentTitle: m.agent.title,
        role: m.role === 'ASSISTANT' ? 'assistant' : 'user',
        content: m.content,
        referencedMessageIds: m.referencedMessageIds,
        createdAt: m.createdAt.toISOString(),
        author: m.author,
      })),
    });
  }),
);

export default router;
