import type { GlossaryEntry } from '@prisma/client';
import { prisma } from '../../lib/prisma';
import { llm } from '../../llm';
import { env } from '../../config/env';
import { logger } from '../../lib/logger';
import { translationProvider } from './provider';
import { languageName } from './languages';

export interface TranslateCell {
  lang: string;
  /** The Localizer API translation. */
  api: string;
  apiLen: number;
  /** Whether the API translation is within maxChars (true when no limit set). */
  fits: boolean;
  /** A Gemini variant produced when over the limit or when glossary terms apply. */
  variant: string | null;
  variantLen: number | null;
  /** Glossary source terms that were enforced in the variant. */
  glossaryApplied: string[];
}

export interface TranslateRow {
  source: string;
  translations: TranslateCell[];
}

interface RunInput {
  texts: string[];
  targetLangs: string[];
  maxChars?: number;
  contentType: string;
}

/** Count Unicode code points (closer to "characters" than .length for limits). */
const charLen = (s: string): number => [...s].length;

export async function runTranslation(input: RunInput): Promise<TranslateRow[]> {
  const { texts, targetLangs, maxChars, contentType } = input;

  // Load the shared glossary for the requested languages once, grouped by lang.
  const glossary = await prisma.glossaryEntry.findMany({
    where: { targetLang: { in: targetLangs } },
  });
  const glossaryByLang = new Map<string, GlossaryEntry[]>();
  for (const g of glossary) {
    const arr = glossaryByLang.get(g.targetLang) ?? [];
    arr.push(g);
    glossaryByLang.set(g.targetLang, arr);
  }

  // One batched provider call → { lang: [translations aligned to texts] }.
  const matrix = await translationProvider.translate({ texts, targetLangs, contentType });

  // Compute per-language cells (with Gemini variants where needed) concurrently.
  return Promise.all(
    texts.map(async (source, textIndex): Promise<TranslateRow> => {
      const translations = await Promise.all(
        targetLangs.map(async (lang): Promise<TranslateCell> => {
          const api = matrix[lang]?.[textIndex] ?? '';
          const apiLen = charLen(api);
          const fits = maxChars == null || apiLen <= maxChars;
          const matches = (glossaryByLang.get(lang) ?? []).filter((g) =>
            source.toLowerCase().includes(g.sourceTermLower),
          );

          let variant: string | null = null;
          if (!fits || matches.length > 0) {
            variant = await geminiVariant({ source, lang, maxChars, matches });
          }
          return {
            lang,
            api,
            apiLen,
            fits,
            variant,
            variantLen: variant == null ? null : charLen(variant),
            glossaryApplied: matches.map((m) => m.sourceTerm),
          };
        }),
      );
      return { source, translations };
    }),
  );
}

async function geminiVariant(opts: {
  source: string;
  lang: string;
  maxChars?: number;
  matches: GlossaryEntry[];
}): Promise<string | null> {
  const { source, lang, maxChars, matches } = opts;
  const rules = [
    `Translate the text into ${languageName(lang)} (${lang}).`,
    'Do NOT translate placeholders such as {name}, {{var}}, %s, %d, or HTML tags like <b>.',
    'Return ONLY the translation — no quotes, labels, or commentary.',
  ];
  if (maxChars != null) {
    rules.push(
      `The translation MUST be at most ${maxChars} characters. Abbreviate naturally while preserving meaning.`,
    );
  }
  if (matches.length > 0) {
    rules.push(
      `Use these exact term translations: ${matches
        .map((m) => `"${m.sourceTerm}" -> "${m.preferredTranslation}"`)
        .join('; ')}.`,
    );
  }

  try {
    const text = await llm.generateText({
      systemInstruction: 'You are a professional software localizer.',
      history: [],
      prompt: `${rules.join('\n')}\n\nText:\n"""${source}"""`,
      model: env.TRANSLATE_FIT_MODEL,
    });
    const cleaned = text.replace(/^["'`]+|["'`]+$/g, '').trim();
    return cleaned || null;
  } catch (err) {
    logger.warn('Variant generation failed', {
      lang,
      message: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
}
