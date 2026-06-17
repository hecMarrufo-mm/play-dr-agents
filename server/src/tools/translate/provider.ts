import { env } from '../../config/env';
import { MockTranslationProvider } from './mock';
import { LazarusTranslationProvider } from './lazarus';
import { PathwaysTranslationProvider } from './pathways';

export interface TranslateBatchInput {
  /** All source texts to translate (batched). */
  texts: string[];
  /** BCP-47 target language codes. */
  targetLangs: string[];
  /** Optional contentType hint (used by some providers, ignored by others). */
  contentType: string;
}

/**
 * Machine-translation backend. `pathways` calls the whitelisted Monksflow
 * Pathways trigger; `lazarus` calls Google Localizer (needs allow-listing);
 * `mock` returns deterministic fakes for local dev/tests.
 *
 * Batched by design: translate MANY texts into MANY languages at once, returning
 * `{ langCode: [translations aligned to `texts`] }`.
 */
export interface TranslationProvider {
  readonly name: string;
  translate(input: TranslateBatchInput): Promise<Record<string, string[]>>;
}

function build(): TranslationProvider {
  switch (env.TRANSLATE_PROVIDER) {
    case 'pathways':
      // Fall back to mock if the trigger URL/key weren't provided, so a config
      // gap degrades the Localizer rather than crashing the whole service.
      if (!env.PATHWAYS_TRIGGER_URL || !env.PATHWAYS_API_KEY) {
        // eslint-disable-next-line no-console
        console.warn('[translate] pathways selected but not configured — using mock translator');
        return new MockTranslationProvider();
      }
      return new PathwaysTranslationProvider();
    case 'lazarus':
      if (!env.LOCALIZER_PRINCIPAL) {
        // eslint-disable-next-line no-console
        console.warn('[translate] lazarus selected but not configured — using mock translator');
        return new MockTranslationProvider();
      }
      return new LazarusTranslationProvider();
    default:
      return new MockTranslationProvider();
  }
}

export const translationProvider: TranslationProvider = build();
