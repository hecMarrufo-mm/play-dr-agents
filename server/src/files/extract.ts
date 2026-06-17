import mammoth from 'mammoth';
import TurndownService from 'turndown';
import * as XLSX from 'xlsx';
import pdfParse from 'pdf-parse';
import { logger } from '../lib/logger';

const turndown = new TurndownService({ headingStyle: 'atx', codeBlockStyle: 'fenced' });

// Don't try to parse enormous files, and cap how much text we store/inject.
const MAX_EXTRACT_BYTES = 25 * 1024 * 1024;
const MAX_TEXT_CHARS = 200_000;

function isTextLike(mime: string): boolean {
  return mime.startsWith('text/') && mime !== 'text/html'
    ? true
    : /(json|csv|yaml|x-yaml|markdown|plain)/.test(mime);
}

/**
 * Convert an uploaded document to markdown/plain text for use as LLM context.
 *
 * Parsing once at upload (stored in File.extractedText) means later prompts
 * inject clean text instead of re-downloading + base64-encoding the file on
 * every message — faster, cheaper, and it lets the model read formats it can't
 * ingest natively (docx/xlsx). Returns null for images/unknown types (those are
 * still sent to the model as native inline data at chat time).
 */
export async function extractToMarkdown(
  buffer: Buffer,
  mimeType: string,
  filename: string,
): Promise<string | null> {
  try {
    if (buffer.byteLength > MAX_EXTRACT_BYTES) return null;
    const lower = filename.toLowerCase();
    let text: string | null = null;

    if (mimeType === 'application/pdf' || lower.endsWith('.pdf')) {
      text = (await pdfParse(buffer)).text;
    } else if (
      mimeType === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' ||
      lower.endsWith('.docx')
    ) {
      const { value: html } = await mammoth.convertToHtml({ buffer });
      text = turndown.turndown(html);
    } else if (
      mimeType === 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' ||
      mimeType === 'application/vnd.ms-excel' ||
      lower.endsWith('.xlsx') ||
      lower.endsWith('.xls')
    ) {
      const wb = XLSX.read(buffer, { type: 'buffer' });
      text = wb.SheetNames.map((name) => `## ${name}\n\n${XLSX.utils.sheet_to_csv(wb.Sheets[name])}`).join('\n\n');
    } else if (mimeType === 'text/html' || lower.endsWith('.html') || lower.endsWith('.htm')) {
      text = turndown.turndown(buffer.toString('utf8'));
    } else if (isTextLike(mimeType)) {
      text = buffer.toString('utf8');
    }

    text = text?.trim() ?? '';
    if (!text) return null;
    return text.length > MAX_TEXT_CHARS ? `${text.slice(0, MAX_TEXT_CHARS)}\n\n…[truncated]` : text;
  } catch (err) {
    logger.warn('File extraction failed', {
      filename,
      mimeType,
      message: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
}
