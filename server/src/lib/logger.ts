/* Minimal structured logger. Emits single-line JSON in production (Cloud Logging
 * friendly) and readable text in development. */
import { env } from '../config/env';

type Level = 'debug' | 'info' | 'warn' | 'error';

function emit(level: Level, msg: string, meta?: Record<string, unknown>) {
  if (env.isProd) {
    // eslint-disable-next-line no-console
    console[level === 'debug' ? 'log' : level](
      JSON.stringify({ severity: level.toUpperCase(), message: msg, ...meta }),
    );
  } else {
    const suffix = meta && Object.keys(meta).length ? ` ${JSON.stringify(meta)}` : '';
    // eslint-disable-next-line no-console
    console[level === 'debug' ? 'log' : level](`[${level}] ${msg}${suffix}`);
  }
}

export const logger = {
  debug: (msg: string, meta?: Record<string, unknown>) => emit('debug', msg, meta),
  info: (msg: string, meta?: Record<string, unknown>) => emit('info', msg, meta),
  warn: (msg: string, meta?: Record<string, unknown>) => emit('warn', msg, meta),
  error: (msg: string, meta?: Record<string, unknown>) => emit('error', msg, meta),
};
