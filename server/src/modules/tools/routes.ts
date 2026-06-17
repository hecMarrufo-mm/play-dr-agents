import { Router } from 'express';
import { z } from 'zod';
import type { GlossaryEntry } from '@prisma/client';
import { prisma } from '../../lib/prisma';
import { env } from '../../config/env';
import { asyncHandler, forbidden, notFound } from '../../lib/errors';
import { parse } from '../../lib/validate';
import { LANGUAGES, CONTENT_TYPES } from '../../tools/translate/languages';
import { runTranslation } from '../../tools/translate/service';

/** Mounted at /api/tools. Built-in tool agents (currently the Localizer). */
const router = Router();

const userSelect = { id: true, name: true, email: true, avatarUrl: true } as const;
type GlossaryWithAuthor = GlossaryEntry & {
  createdBy: { id: string; name: string; email: string; avatarUrl: string | null } | null;
};

function serializeGlossary(g: GlossaryWithAuthor) {
  return {
    id: g.id,
    sourceTerm: g.sourceTerm,
    targetLang: g.targetLang,
    preferredTranslation: g.preferredTranslation,
    note: g.note,
    createdAt: g.createdAt.toISOString(),
    createdBy: g.createdBy,
  };
}

/** GET /api/tools/translate/config — languages, content types, provider info for the UI. */
router.get(
  '/translate/config',
  asyncHandler(async (_req, res) => {
    res.json({
      languages: LANGUAGES,
      contentTypes: CONTENT_TYPES,
      defaultContentType: env.LOCALIZER_DEFAULT_CONTENT_TYPE,
      provider: env.TRANSLATE_PROVIDER,
    });
  }),
);

const translateSchema = z.object({
  texts: z.array(z.string()).min(1).max(200),
  targetLangs: z.array(z.string().min(2).max(20)).min(1).max(40),
  maxChars: z.number().int().positive().max(100_000).optional(),
  contentType: z.string().optional(),
});

/** POST /api/tools/translate — translate texts into many languages (+ char-limit/glossary variants). */
router.post(
  '/translate',
  asyncHandler(async (req, res) => {
    const body = parse(translateSchema, req.body);
    const texts = body.texts.map((t) => t.trim()).filter(Boolean);
    if (texts.length === 0) {
      res.json({ results: [] });
      return;
    }
    const results = await runTranslation({
      texts,
      targetLangs: body.targetLangs,
      maxChars: body.maxChars,
      contentType: body.contentType || env.LOCALIZER_DEFAULT_CONTENT_TYPE,
    });
    res.json({ results });
  }),
);

/** GET /api/tools/translate/glossary[?lang=] — the shared dictionary. */
router.get(
  '/translate/glossary',
  asyncHandler(async (req, res) => {
    const lang = typeof req.query.lang === 'string' ? req.query.lang : undefined;
    const entries = await prisma.glossaryEntry.findMany({
      where: lang ? { targetLang: lang } : {},
      orderBy: { updatedAt: 'desc' },
      include: { createdBy: { select: userSelect } },
    });
    res.json({ entries: entries.map((e) => serializeGlossary(e as GlossaryWithAuthor)) });
  }),
);

const glossarySchema = z.object({
  sourceTerm: z.string().trim().min(1).max(200),
  targetLang: z.string().min(2).max(20),
  preferredTranslation: z.string().trim().min(1).max(500),
  note: z.string().max(500).optional().default(''),
});

/** POST /api/tools/translate/glossary — add or update a dictionary entry (learn from a correction). */
router.post(
  '/translate/glossary',
  asyncHandler(async (req, res) => {
    const b = parse(glossarySchema, req.body);
    const sourceTermLower = b.sourceTerm.toLowerCase();
    const entry = await prisma.glossaryEntry.upsert({
      where: { sourceTermLower_targetLang: { sourceTermLower, targetLang: b.targetLang } },
      update: { sourceTerm: b.sourceTerm, preferredTranslation: b.preferredTranslation, note: b.note },
      create: {
        sourceTerm: b.sourceTerm,
        sourceTermLower,
        targetLang: b.targetLang,
        preferredTranslation: b.preferredTranslation,
        note: b.note,
        createdById: req.user!.id,
      },
      include: { createdBy: { select: userSelect } },
    });
    res.status(201).json({ entry: serializeGlossary(entry as GlossaryWithAuthor) });
  }),
);

/** DELETE /api/tools/translate/glossary/:id — creator or admin only. */
router.delete(
  '/translate/glossary/:id',
  asyncHandler(async (req, res) => {
    const entry = await prisma.glossaryEntry.findUnique({ where: { id: req.params.id } });
    if (!entry) throw notFound('Glossary entry not found');
    if (req.user!.role !== 'ADMIN' && entry.createdById !== req.user!.id) throw forbidden();
    await prisma.glossaryEntry.delete({ where: { id: req.params.id } });
    res.status(204).end();
  }),
);

export default router;
