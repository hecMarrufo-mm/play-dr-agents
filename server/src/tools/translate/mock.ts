import type { TranslateBatchInput, TranslationProvider } from './provider';

/** Deterministic fake translator for local development and tests. */
export class MockTranslationProvider implements TranslationProvider {
  readonly name = 'mock';

  async translate({ texts, targetLangs }: TranslateBatchInput): Promise<Record<string, string[]>> {
    const out: Record<string, string[]> = {};
    for (const lang of targetLangs) {
      out[lang] = texts.map((t) => `[${lang}] ${t}`);
    }
    return out;
  }
}
