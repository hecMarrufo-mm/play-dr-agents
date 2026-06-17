// Load .env for local dev before anything reads process.env. In Cloud Run there
// is no .env file and real environment variables are used instead (a no-op here).
import 'dotenv/config';
import { createApp } from './app';
import { env } from './config/env';
import { logger } from './lib/logger';
import { prisma } from './lib/prisma';

const app = createApp();

const server = app.listen(env.PORT, () => {
  logger.info(`Play DR Agents listening on :${env.PORT}`, {
    nodeEnv: env.NODE_ENV,
    storage: env.STORAGE_DRIVER,
    model: env.GEMINI_MODEL,
  });
});

async function shutdown(signal: string) {
  logger.info(`Received ${signal}, shutting down`);
  server.close(() => undefined);
  await prisma.$disconnect().catch(() => undefined);
  process.exit(0);
}

process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));
