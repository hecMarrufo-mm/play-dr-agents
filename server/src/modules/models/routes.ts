import { Router } from 'express';
import { env } from '../../config/env';
import { AVAILABLE_MODELS } from '../../llm';
import { asyncHandler } from '../../lib/errors';

/** Mounted at /api/models. Powers the per-agent model dropdown. */
const router = Router();

router.get(
  '/',
  asyncHandler(async (_req, res) => {
    res.json({ models: AVAILABLE_MODELS, default: env.GEMINI_MODEL });
  }),
);

export default router;
