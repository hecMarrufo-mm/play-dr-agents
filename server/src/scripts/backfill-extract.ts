/**
 * Backfill File.extractedText for files uploaded before the parser existed
 * (or before STORAGE_DRIVER could reach them). Non-destructive: only sets
 * extractedText where it is currently null.
 *
 *   npm run backfill:extract
 */
import 'dotenv/config';
import { prisma } from '../lib/prisma';
import { storage } from '../storage';
import { extractToMarkdown } from '../files/extract';
import { logger } from '../lib/logger';

async function main() {
  const files = await prisma.file.findMany({ where: { extractedText: null } });
  logger.info(`Backfilling extraction for ${files.length} file(s)`);

  let updated = 0;
  for (const f of files) {
    try {
      const bytes = await storage.getBytes(f.storageKey);
      const text = await extractToMarkdown(bytes, f.mimeType, f.filename);
      if (text) {
        await prisma.file.update({ where: { id: f.id }, data: { extractedText: text } });
        updated++;
        logger.info(`extracted: ${f.filename} (${text.length} chars)`);
      } else {
        logger.info(`no text extracted, kept native: ${f.filename}`);
      }
    } catch (err) {
      logger.warn(`backfill failed: ${f.filename}`, {
        message: err instanceof Error ? err.message : String(err),
      });
    }
  }
  logger.info(`Backfill complete: ${updated}/${files.length} files updated`);
}

main()
  .catch((err) => {
    logger.error('Backfill error', { message: err instanceof Error ? err.message : String(err) });
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
