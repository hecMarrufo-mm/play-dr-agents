import type { NextFunction, Request, Response } from 'express';
import { MulterError } from 'multer';
import { AppError } from '../lib/errors';
import { logger } from '../lib/logger';

/** 404 handler for unmatched /api routes. */
export function notFoundHandler(req: Request, res: Response) {
  res.status(404).json({ error: { code: 'not_found', message: `No route for ${req.method} ${req.path}` } });
}

/** Terminal error handler. Maps known errors to clean JSON; hides internals otherwise. */
export function errorHandler(err: unknown, req: Request, res: Response, _next: NextFunction) {
  if (res.headersSent) return; // streaming responses (SSE) handle their own errors

  if (err instanceof AppError) {
    res.status(err.status).json({ error: { code: err.code, message: err.message, details: err.details } });
    return;
  }

  if (err instanceof MulterError) {
    const status = err.code === 'LIMIT_FILE_SIZE' ? 413 : 400;
    res.status(status).json({ error: { code: err.code.toLowerCase(), message: err.message } });
    return;
  }

  const message = err instanceof Error ? err.message : 'Unknown error';
  logger.error('Unhandled error', { message, path: req.path, method: req.method });
  res.status(500).json({ error: { code: 'internal_error', message: 'Something went wrong' } });
}
