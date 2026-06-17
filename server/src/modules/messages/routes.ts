import { Router } from 'express';
import { z } from 'zod';
import { prisma } from '../../lib/prisma';
import { storage } from '../../storage';
import { llm, type LlmFile, type LlmTurn } from '../../llm';
import { asyncHandler, notFound } from '../../lib/errors';
import { parse } from '../../lib/validate';
import { logger } from '../../lib/logger';
import { serializeMessage, type MessageWithAuthor } from './serialize';

/** Mounted at /api/agents/:agentId/messages (mergeParams gives us agentId). */
const router = Router({ mergeParams: true });

const messageInclude = {
  author: { select: { id: true, name: true, email: true, avatarUrl: true } },
} as const;

// Caps to keep prompts and file payloads bounded.
const MAX_HISTORY_TURNS = 40;
const MAX_TOTAL_FILE_BYTES = 15 * 1024 * 1024;
const MAX_CONTEXT_CHARS = 100_000;

const postSchema = z.object({
  content: z.string().trim().min(1, 'Message cannot be empty').max(32_000),
  /** Include the full prior thread as context (default true). */
  includeHistory: z.boolean().optional().default(true),
  /** Explicitly selected prior message ids to use as context (overrides includeHistory). */
  referencedMessageIds: z.array(z.string().cuid()).max(200).optional().default([]),
});

async function getAgentOr404(agentId: string) {
  const agent = await prisma.agent.findUnique({
    where: { id: agentId },
    include: { files: { include: { file: true } } },
  });
  if (!agent) throw notFound('Agent not found');
  return agent;
}

/** GET /api/agents/:agentId/messages — the full shared thread, oldest first. */
router.get(
  '/',
  asyncHandler(async (req, res) => {
    const agentId = req.params.agentId;
    await getAgentOr404(agentId);
    // Optional ?since=<ISO> for cheap incremental polling (live thread updates).
    const since = typeof req.query.since === 'string' ? new Date(req.query.since) : null;
    const where =
      since && !Number.isNaN(since.getTime()) ? { agentId, createdAt: { gt: since } } : { agentId };
    const messages = await prisma.message.findMany({
      where,
      orderBy: { createdAt: 'asc' },
      include: messageInclude,
    });
    res.json({ messages: messages.map((m) => serializeMessage(m as MessageWithAuthor)) });
  }),
);

/**
 * POST /api/agents/:agentId/messages — send a prompt and stream the reply.
 *
 * Persists the user message immediately (it becomes shared knowledge), builds
 * context from the agent's instructions + selected history + attached files,
 * streams Gemini's response over SSE, then persists the assistant message.
 */
router.post(
  '/',
  asyncHandler(async (req, res) => {
    const agentId = req.params.agentId;
    const author = req.user!;
    const body = parse(postSchema, req.body);

    const agent = await getAgentOr404(agentId);

    // Persist the user's prompt first so it is never lost, even if Gemini fails.
    const userMessage = await prisma.message.create({
      data: {
        agentId,
        authorId: author.id,
        role: 'USER',
        content: body.content,
        referencedMessageIds: body.referencedMessageIds,
      },
      include: messageInclude,
    });

    // Build conversation context.
    const history = await buildHistory(agentId, userMessage.id, body);

    // Load attached files (shared library) as model context, bounded by size.
    const files = await loadAgentFiles(agent.files.map((af) => af.file));

    // --- Server-Sent Events stream ---
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    const send = (event: string, data: unknown) => {
      res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    };

    // Tell the client the user message id up front so it can render immediately.
    send('user', serializeMessage(userMessage as MessageWithAuthor));

    let full = '';
    try {
      for await (const chunk of llm.generateStream({
        systemInstruction: agent.instructions,
        history,
        prompt: body.content,
        files,
        model: agent.model ?? undefined,
      })) {
        full += chunk;
        send('chunk', { text: chunk });
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : 'The model failed to respond';
      logger.error('Gemini stream failed', { agentId, message });
      send('error', { message: `Gemini error: ${message}` });
      res.end();
      return;
    }

    const assistantMessage = await prisma.message.create({
      data: {
        agentId,
        authorId: null,
        role: 'ASSISTANT',
        content: full,
        referencedMessageIds: [],
      },
      include: messageInclude,
    });

    send('done', { assistantMessage: serializeMessage(assistantMessage as MessageWithAuthor) });
    res.end();
  }),
);

/** Resolve which prior messages to send as context. */
async function buildHistory(
  agentId: string,
  excludeMessageId: string,
  body: z.infer<typeof postSchema>,
): Promise<LlmTurn[]> {
  if (body.referencedMessageIds.length > 0) {
    // Referenced messages may come from OTHER agents' threads (shared knowledge).
    // Tag cross-agent messages with their source so the model has provenance.
    const selected = await prisma.message.findMany({
      where: { id: { in: body.referencedMessageIds } },
      orderBy: { createdAt: 'asc' },
      include: { agent: { select: { title: true } } },
    });
    const turns = selected.map<LlmTurn>((m) => ({
      role: m.role === 'ASSISTANT' ? 'assistant' : 'user',
      content: m.agentId === agentId ? m.content : `[from agent "${m.agent.title}"]\n${m.content}`,
    }));
    return capByChars(turns, MAX_CONTEXT_CHARS);
  }
  if (!body.includeHistory) return [];

  const prior = await prisma.message.findMany({
    where: { agentId, id: { not: excludeMessageId } },
    orderBy: { createdAt: 'desc' },
    take: MAX_HISTORY_TURNS,
  });
  return capByChars(prior.reverse().map(toTurn), MAX_CONTEXT_CHARS);
}

/** Keep the most recent turns within a character budget (protects the context window). */
function capByChars(turns: LlmTurn[], budget: number): LlmTurn[] {
  let total = 0;
  const kept: LlmTurn[] = [];
  for (let i = turns.length - 1; i >= 0; i--) {
    total += turns[i].content.length;
    if (total > budget && kept.length > 0) break;
    kept.unshift(turns[i]);
  }
  return kept;
}

function toTurn(m: { role: 'USER' | 'ASSISTANT'; content: string }): LlmTurn {
  return { role: m.role === 'ASSISTANT' ? 'assistant' : 'user', content: m.content };
}

/** Load file bytes for the model, skipping anything that would blow the size budget. */
async function loadAgentFiles(
  files: {
    filename: string;
    mimeType: string;
    size: number;
    storageKey: string;
    extractedText: string | null;
  }[],
): Promise<LlmFile[]> {
  const out: LlmFile[] = [];
  let total = 0;
  for (const f of files) {
    // Prefer text parsed at upload — no download, no base64, much cheaper/faster.
    if (f.extractedText) {
      out.push({ filename: f.filename, mimeType: f.mimeType, text: f.extractedText });
      continue;
    }
    // Otherwise stream raw bytes (e.g. images for native vision), bounded by size.
    if (total + f.size > MAX_TOTAL_FILE_BYTES) {
      logger.warn('Skipping file for context (size budget exceeded)', { file: f.filename });
      continue;
    }
    try {
      const data = await storage.getBytes(f.storageKey);
      out.push({ filename: f.filename, mimeType: f.mimeType, data });
      total += data.byteLength;
    } catch (err) {
      logger.warn('Could not load attached file for context', {
        file: f.filename,
        message: err instanceof Error ? err.message : String(err),
      });
    }
  }
  return out;
}

export default router;
