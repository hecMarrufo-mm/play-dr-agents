import { Router } from 'express';
import { z } from 'zod';
import { prisma } from '../../lib/prisma';
import { asyncHandler, badRequest, forbidden, notFound } from '../../lib/errors';
import { parse } from '../../lib/validate';

/** Mounted at /api/agents. */
const router = Router();

const userSelect = { id: true, name: true, email: true, avatarUrl: true } as const;

// Include used for both gallery list items and agent detail: owner identity,
// counts of messages/files, and the single newest message (for lastActivityAt).
const agentInclude = {
  owner: { select: userSelect },
  _count: { select: { messages: true, files: true } },
  messages: { orderBy: { createdAt: 'desc' }, take: 1, select: { createdAt: true } },
} as const;

type AgentWithMeta = {
  id: string;
  title: string;
  description: string;
  instructions: string;
  model: string | null;
  createdAt: Date;
  updatedAt: Date;
  owner: { id: string; name: string; email: string; avatarUrl: string | null };
  _count: { messages: number; files: number };
  messages: { createdAt: Date }[];
};

type AgentFileWithFile = {
  file: {
    id: string;
    filename: string;
    mimeType: string;
    size: number;
    createdAt: Date;
    extractedText: string | null;
    uploader: { id: string; name: string; email: string; avatarUrl: string | null };
    _count: { agents: number };
  };
};

const agentInput = z.object({
  title: z.string().trim().min(1, 'Title is required').max(200),
  description: z.string().trim().min(1, 'Description is required').max(4000),
  instructions: z.string().trim().min(1, 'Instructions are required').max(50_000),
  fileIds: z.array(z.string()).max(50).default([]),
  model: z
    .string()
    .max(100)
    .optional()
    .transform((v) => (v && v.trim() ? v.trim() : null)),
});

/** Most recent activity: newest message timestamp, falling back to updatedAt. */
function lastActivityAt(agent: AgentWithMeta): string {
  const newest = agent.messages[0]?.createdAt ?? agent.updatedAt;
  return newest.toISOString();
}

function serializeListItem(agent: AgentWithMeta) {
  return {
    id: agent.id,
    title: agent.title,
    description: agent.description,
    owner: agent.owner,
    createdAt: agent.createdAt.toISOString(),
    updatedAt: agent.updatedAt.toISOString(),
    messageCount: agent._count.messages,
    fileCount: agent._count.files,
    lastActivityAt: lastActivityAt(agent),
  };
}

function serializeFile(af: AgentFileWithFile) {
  const f = af.file;
  return {
    id: f.id,
    filename: f.filename,
    mimeType: f.mimeType,
    size: f.size,
    createdAt: f.createdAt.toISOString(),
    uploader: f.uploader,
    agentCount: f._count.agents,
    hasExtractedText: Boolean(f.extractedText),
  };
}

type UserSummary = { id: string; name: string; email: string; avatarUrl: string | null };

function serializeDetail(agent: AgentWithMeta, files: AgentFileWithFile[], coOwners: UserSummary[]) {
  return {
    id: agent.id,
    title: agent.title,
    description: agent.description,
    instructions: agent.instructions,
    model: agent.model,
    owner: agent.owner,
    coOwners,
    createdAt: agent.createdAt.toISOString(),
    updatedAt: agent.updatedAt.toISOString(),
    messageCount: agent._count.messages,
    lastActivityAt: lastActivityAt(agent),
    files: files.map(serializeFile),
  };
}

/** Load an agent's attached files (shared library) as wire-shaped FileSummary rows. */
async function loadAgentFiles(agentId: string): Promise<AgentFileWithFile[]> {
  return prisma.agentFile.findMany({
    where: { agentId },
    include: {
      file: {
        include: {
          uploader: { select: userSelect },
          _count: { select: { agents: true } },
        },
      },
    },
  });
}

/** Load an agent's co-owners as UserSummary rows. */
async function loadCoOwners(agentId: string): Promise<UserSummary[]> {
  const rows = await prisma.agentOwner.findMany({
    where: { agentId },
    include: { user: { select: userSelect } },
    orderBy: { createdAt: 'asc' },
  });
  return rows.map((r) => r.user);
}

/** Build the full AgentDetail wire object (loads files + co-owners). */
async function buildDetail(agent: AgentWithMeta) {
  const [files, coOwners] = await Promise.all([loadAgentFiles(agent.id), loadCoOwners(agent.id)]);
  return serializeDetail(agent, files, coOwners);
}

/** Whether `user` may manage the agent: primary owner, a co-owner, or an admin. */
async function getManageable(id: string, userId: string, role: string) {
  const agent = await prisma.agent.findUnique({
    where: { id },
    select: { ownerId: true, coOwners: { select: { userId: true } } },
  });
  if (!agent) return { found: false as const };
  const isManager =
    role === 'ADMIN' || agent.ownerId === userId || agent.coOwners.some((c) => c.userId === userId);
  return { found: true as const, isManager, ownerId: agent.ownerId };
}

/** GET /api/agents — the gallery: every agent, newest activity first. */
router.get(
  '/',
  asyncHandler(async (_req, res) => {
    const agents = await prisma.agent.findMany({ include: agentInclude });
    const items = (agents as AgentWithMeta[]).map(serializeListItem);
    items.sort((a, b) => b.lastActivityAt.localeCompare(a.lastActivityAt));
    res.json({ agents: items });
  }),
);

/** POST /api/agents — create an agent owned by the current user. */
router.post(
  '/',
  asyncHandler(async (req, res) => {
    const user = req.user!;
    const body = parse(agentInput, req.body);

    // Link only file ids that actually exist in the shared library.
    const validIds = await existingFileIds(body.fileIds);

    const created = await prisma.agent.create({
      data: {
        title: body.title,
        description: body.description,
        instructions: body.instructions,
        model: body.model,
        ownerId: user.id,
        files: { create: validIds.map((fileId) => ({ fileId })) },
      },
      include: agentInclude,
    });

    res.status(201).json({ agent: await buildDetail(created as AgentWithMeta) });
  }),
);

/** GET /api/agents/:id — full agent detail. */
router.get(
  '/:id',
  asyncHandler(async (req, res) => {
    const agent = await prisma.agent.findUnique({
      where: { id: req.params.id },
      include: agentInclude,
    });
    if (!agent) throw notFound('Agent not found');

    res.json({ agent: await buildDetail(agent as AgentWithMeta) });
  }),
);

/** PATCH /api/agents/:id — update (owner, co-owner, or admin); reconciles the attached file set. */
router.patch(
  '/:id',
  asyncHandler(async (req, res) => {
    const user = req.user!;
    const id = req.params.id;

    const m = await getManageable(id, user.id, user.role);
    if (!m.found) throw notFound('Agent not found');
    if (!m.isManager) throw forbidden('Only an owner or co-owner can edit this agent');

    const body = parse(agentInput, req.body);
    const validIds = await existingFileIds(body.fileIds);

    // Reconcile attachments to EXACTLY the valid file ids, then update fields.
    const updated = await prisma.$transaction(async (tx) => {
      await tx.agentFile.deleteMany({ where: { agentId: id } });
      if (validIds.length > 0) {
        await tx.agentFile.createMany({
          data: validIds.map((fileId) => ({ agentId: id, fileId })),
        });
      }
      return tx.agent.update({
        where: { id },
        data: {
          title: body.title,
          description: body.description,
          instructions: body.instructions,
          model: body.model,
        },
        include: agentInclude,
      });
    });

    res.json({ agent: await buildDetail(updated as AgentWithMeta) });
  }),
);

/** DELETE /api/agents/:id — owner, co-owner, or admin; cascade removes files/messages/co-owners. */
router.delete(
  '/:id',
  asyncHandler(async (req, res) => {
    const user = req.user!;
    const id = req.params.id;

    const m = await getManageable(id, user.id, user.role);
    if (!m.found) throw notFound('Agent not found');
    if (!m.isManager) throw forbidden('Only an owner or co-owner can delete this agent');

    await prisma.agent.delete({ where: { id } });
    res.status(204).end();
  }),
);

/** PATCH /api/agents/:id/owner — transfer ownership to another user (current owner or admin). */
router.patch(
  '/:id/owner',
  asyncHandler(async (req, res) => {
    const user = req.user!;
    const id = req.params.id;

    const existing = await prisma.agent.findUnique({ where: { id }, select: { ownerId: true } });
    if (!existing) throw notFound('Agent not found');
    if (existing.ownerId !== user.id && user.role !== 'ADMIN') {
      throw forbidden('Only the owner can transfer this agent');
    }

    const { ownerId } = parse(z.object({ ownerId: z.string().min(1) }), req.body);
    const target = await prisma.user.findUnique({ where: { id: ownerId }, select: { id: true } });
    if (!target) throw notFound('Target user not found');

    const updated = await prisma.agent.update({
      where: { id },
      data: { ownerId },
      include: agentInclude,
    });
    res.json({ agent: await buildDetail(updated as AgentWithMeta) });
  }),
);

const addOwnerSchema = z.object({ userId: z.string().min(1) });

/** POST /api/agents/:id/owners — add a co-owner (owner, co-owner, or admin). */
router.post(
  '/:id/owners',
  asyncHandler(async (req, res) => {
    const user = req.user!;
    const id = req.params.id;
    const m = await getManageable(id, user.id, user.role);
    if (!m.found) throw notFound('Agent not found');
    if (!m.isManager) throw forbidden('Only an owner or co-owner can manage owners');

    const { userId } = parse(addOwnerSchema, req.body);
    if (userId === m.ownerId) throw badRequest('That user is already the primary owner');
    const target = await prisma.user.findUnique({ where: { id: userId }, select: { id: true } });
    if (!target) throw notFound('User not found');

    await prisma.agentOwner.upsert({
      where: { agentId_userId: { agentId: id, userId } },
      update: {},
      create: { agentId: id, userId },
    });

    const agent = await prisma.agent.findUnique({ where: { id }, include: agentInclude });
    res.status(201).json({ agent: await buildDetail(agent as AgentWithMeta) });
  }),
);

/** DELETE /api/agents/:id/owners/:userId — remove a co-owner (owner, co-owner, or admin). */
router.delete(
  '/:id/owners/:userId',
  asyncHandler(async (req, res) => {
    const user = req.user!;
    const id = req.params.id;
    const m = await getManageable(id, user.id, user.role);
    if (!m.found) throw notFound('Agent not found');
    if (!m.isManager) throw forbidden('Only an owner or co-owner can manage owners');

    await prisma.agentOwner.deleteMany({ where: { agentId: id, userId: req.params.userId } });

    const agent = await prisma.agent.findUnique({ where: { id }, include: agentInclude });
    res.json({ agent: await buildDetail(agent as AgentWithMeta) });
  }),
);

/** Filter the requested ids down to files that actually exist in the library. */
async function existingFileIds(fileIds: string[]): Promise<string[]> {
  if (fileIds.length === 0) return [];
  const found = await prisma.file.findMany({
    where: { id: { in: fileIds } },
    select: { id: true },
  });
  return found.map((f) => f.id);
}

export default router;
