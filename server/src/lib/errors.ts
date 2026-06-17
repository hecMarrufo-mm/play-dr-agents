import type { NextFunction, Request, Response } from 'express';

/** An error with an associated HTTP status code, safe to surface to clients. */
export class AppError extends Error {
  status: number;
  code: string;
  details?: unknown;

  constructor(status: number, message: string, code = 'error', details?: unknown) {
    super(message);
    this.name = 'AppError';
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

export const badRequest = (msg = 'Bad request', details?: unknown) =>
  new AppError(400, msg, 'bad_request', details);
export const unauthorized = (msg = 'Authentication required') =>
  new AppError(401, msg, 'unauthorized');
export const forbidden = (msg = 'You do not have permission to do that') =>
  new AppError(403, msg, 'forbidden');
export const notFound = (msg = 'Not found') => new AppError(404, msg, 'not_found');
export const payloadTooLarge = (msg = 'Payload too large') =>
  new AppError(413, msg, 'payload_too_large');

/** Wrap an async route handler so rejected promises reach the error middleware. */
export function asyncHandler<
  T extends (req: Request, res: Response, next: NextFunction) => Promise<unknown>,
>(fn: T) {
  return (req: Request, res: Response, next: NextFunction) => {
    fn(req, res, next).catch(next);
  };
}
