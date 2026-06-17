import { env } from '../../config/env';
import { logger } from '../../lib/logger';
import type { TranslateBatchInput, TranslationProvider } from './provider';

/**
 * Monksflow Pathways translation provider.
 *
 * Calls a whitelisted Pathways trigger (async): POST creates an execution, then
 * we poll until `completed` and read the aligned results. One execution per
 * target language (all copies batched), run in parallel.
 *
 *   POST   {PATHWAYS_TRIGGER_URL}            { inputs: { targetLanguages: [code], copys: [...] } } -> { id }
 *   GET    {PATHWAYS_TRIGGER_URL}/{id}       -> { status, outputs: [{ value: [{ "<code>": "...", original }] }] }
 *
 * Auth: `x-api-key` header.
 */
interface CreateResponse {
  id?: string;
}
interface PollResponse {
  status?: string;
  outputs?: { value?: Array<Record<string, string>> }[];
}

const POLL_INTERVAL_MS = 2000;
const MAX_POLLS = 60; // up to ~2 minutes per language

export class PathwaysTranslationProvider implements TranslationProvider {
  readonly name = 'pathways';

  async translate({ texts, targetLangs }: TranslateBatchInput): Promise<Record<string, string[]>> {
    const entries = await Promise.all(
      targetLangs.map(async (lang) => [lang, await this.translateOne(lang, texts)] as const),
    );
    return Object.fromEntries(entries);
  }

  private headers(accept: string): Record<string, string> {
    return { accept, 'content-type': 'application/json', 'x-api-key': env.PATHWAYS_API_KEY };
  }

  private async translateOne(lang: string, texts: string[]): Promise<string[]> {
    const base = env.PATHWAYS_TRIGGER_URL;

    // 1) Create the execution.
    const created = await fetch(base, {
      method: 'POST',
      headers: this.headers('application/json;v=1'),
      body: JSON.stringify({ inputs: { targetLanguages: [lang], copys: texts } }),
    });
    if (!created.ok) {
      throw new Error(`Pathways create ${created.status}: ${(await created.text()).slice(0, 200)}`);
    }
    const { id } = (await created.json()) as CreateResponse;
    if (!id) throw new Error('Pathways did not return an execution id');

    // 2) Poll until completed.
    const pollUrl = `${base}/${id}`;
    for (let attempt = 0; attempt < MAX_POLLS; attempt++) {
      await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
      const res = await fetch(pollUrl, { headers: this.headers('application/json') });
      if (!res.ok) continue;
      const data = (await res.json()) as PollResponse;
      if (data.status === 'completed') {
        const rows = data.outputs?.[0]?.value ?? [];
        // Results are aligned to the input `copys` order.
        return texts.map((_, i) => rows[i]?.[lang] ?? '');
      }
      if (data.status === 'failed' || data.status === 'error') {
        throw new Error(`Pathways execution ${data.status} for ${lang}`);
      }
    }
    logger.warn('Pathways execution timed out', { lang, ids: texts.length });
    throw new Error(`Pathways timed out after ${(MAX_POLLS * POLL_INTERVAL_MS) / 1000}s for ${lang}`);
  }
}
