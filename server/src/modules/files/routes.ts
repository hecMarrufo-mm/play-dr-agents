import { Router } from 'express';
import multer from 'multer';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { prisma } from '../../lib/prisma';
import { env } from '../../config/env';
import { storage } from '../../storage';
import { extractToMarkdown } from '../../files/extract';
import { asyncHandler, badRequest, forbidden, notFound } from '../../lib/errors';
import { parse } from '../../lib/validate';
import { logger } from '../../lib/logger';

/** Mounted at /api/files — the shared, platform-wide file library. */
const router = Router();

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: env.maxUploadBytes },
});

const fileInclude = {
  uploader: { select: { id: true, name: true, email: true, avatarUrl: true } },
  _count: { select: { agents: true } },
} as const;

type FileWithMeta = {
  id: string;
  filename: string;
  mimeType: string;
  size: number;
  createdAt: Date;
  extractedText: string | null;
  uploader: { id: string; name: string; email: string; avatarUrl: string | null };
  _count: { agents: number };
};

/** Wire shape of a library file (matches the client `FileSummary` type). */
function serializeFile(f: FileWithMeta) {
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

// Allowlist of MIME types we accept into the library.
const ALLOWED_MIME = new Set<string>([
  // images
  'image/png',
  'image/jpeg',
  'image/gif',
  'image/webp',
  'image/svg+xml',
  // documents
  'application/pdf',
  'application/msword',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.ms-excel',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  // text-like
  'application/json',
  'text/csv',
  'text/markdown',
]);

function isAllowedMime(mime: string): boolean {
  return mime.startsWith('text/') || ALLOWED_MIME.has(mime);
}

/** GET /api/files — the whole shared library, newest first. */
router.get(
  '/',
  asyncHandler(async (_req, res) => {
    const files = await prisma.file.findMany({
      orderBy: { createdAt: 'desc' },
      include: fileInclude,
    });
    res.json({ files: files.map((f) => serializeFile(f as FileWithMeta)) });
  }),
);

/** POST /api/files — upload a file into the shared library. */
router.post(
  '/',
  upload.single('file'),
  asyncHandler(async (req, res) => {
    const file = req.file;
    if (!file) throw badRequest('No file uploaded');
    if (!isAllowedMime(file.mimetype)) {
      throw badRequest(`Unsupported file type: ${file.mimetype}`);
    }

    const safe = file.originalname.replace(/[^a-zA-Z0-9._-]/g, '_');
    const key = `${randomUUID()}/${safe}`;
    await storage.save(key, file.buffer, file.mimetype);

    // Parse to markdown/text once, now, so prompts can inject it cheaply later.
    const extractedText = await extractToMarkdown(file.buffer, file.mimetype, file.originalname);

    const created = await prisma.file.create({
      data: {
        filename: file.originalname,
        mimeType: file.mimetype,
        size: file.size,
        storageKey: key,
        extractedText,
        uploaderId: req.user!.id,
      },
      include: fileInclude,
    });

    res.status(201).json({ file: serializeFile(created as FileWithMeta) });
  }),
);

const EXTRACT_LIMIT_BYTES = 25 * 1024 * 1024;

const uploadUrlSchema = z.object({
  filename: z.string().trim().min(1).max(300),
  mimeType: z.string().min(1).max(200),
  size: z.number().int().positive().max(env.maxSignedUploadBytes),
});

/**
 * POST /api/files/upload-url — get a direct-to-GCS upload target for large files.
 * Returns { mode:'signed', uploadUrl, storageKey } (the client PUTs bytes there,
 * then calls /finalize), or { mode:'direct' } when the backend can't sign a URL
 * (local dev) — the client then falls back to the multipart POST /api/files.
 */
router.post(
  '/upload-url',
  asyncHandler(async (req, res) => {
    const b = parse(uploadUrlSchema, req.body);
    if (!isAllowedMime(b.mimeType)) throw badRequest(`Unsupported file type: ${b.mimeType}`);
    const safe = b.filename.replace(/[^a-zA-Z0-9._-]/g, '_');
    const storageKey = `${randomUUID()}/${safe}`;
    const uploadUrl = await storage.createUploadUrl(storageKey, b.mimeType);
    if (!uploadUrl) {
      res.json({ mode: 'direct' });
      return;
    }
    res.json({ mode: 'signed', uploadUrl, storageKey });
  }),
);

const finalizeSchema = z.object({
  storageKey: z.string().min(1).max(400),
  filename: z.string().trim().min(1).max(300),
  mimeType: z.string().min(1).max(200),
  size: z.number().int().nonnegative().max(env.maxSignedUploadBytes),
});

/** POST /api/files/finalize — record a file uploaded via a signed URL; extract text (bounded). */
router.post(
  '/finalize',
  asyncHandler(async (req, res) => {
    const b = parse(finalizeSchema, req.body);
    if (!isAllowedMime(b.mimeType)) throw badRequest(`Unsupported file type: ${b.mimeType}`);
    if (!(await storage.exists(b.storageKey))) {
      throw badRequest('Uploaded object not found — the upload did not complete');
    }

    // Only download + parse files small enough to be worth extracting; bigger files keep bytes only.
    let extractedText: string | null = null;
    if (b.size <= EXTRACT_LIMIT_BYTES) {
      try {
        const bytes = await storage.getBytes(b.storageKey);
        extractedText = await extractToMarkdown(bytes, b.mimeType, b.filename);
      } catch (err) {
        logger.warn('Extraction after signed upload failed', {
          key: b.storageKey,
          message: err instanceof Error ? err.message : String(err),
        });
      }
    }

    const created = await prisma.file.create({
      data: {
        filename: b.filename,
        mimeType: b.mimeType,
        size: b.size,
        storageKey: b.storageKey,
        extractedText,
        uploaderId: req.user!.id,
      },
      include: fileInclude,
    });
    res.status(201).json({ file: serializeFile(created as FileWithMeta) });
  }),
);

/** GET /api/files/:id/content — stream the bytes for download/preview. */
router.get(
  '/:id/content',
  asyncHandler(async (req, res) => {
    const file = await prisma.file.findUnique({ where: { id: req.params.id } });
    if (!file) throw notFound();

    res.setHeader('Content-Type', file.mimeType);
    res.setHeader('Content-Disposition', `inline; filename="${file.filename}"`);

    const stream = storage.createReadStream(file.storageKey);
    stream.on('error', () => {
      if (!res.headersSent) res.status(500).end();
      else res.end();
    });
    stream.pipe(res);
  }),
);

/** DELETE /api/files/:id — remove a file (uploader or admin only). */
router.delete(
  '/:id',
  asyncHandler(async (req, res) => {
    const file = await prisma.file.findUnique({ where: { id: req.params.id } });
    if (!file) throw notFound();

    const user = req.user!;
    if (user.role !== 'ADMIN' && file.uploaderId !== user.id) throw forbidden();

    await storage.delete(file.storageKey).catch(() => {});
    await prisma.file.delete({ where: { id: file.id } });

    res.status(204).end();
  }),
);

export default router;
