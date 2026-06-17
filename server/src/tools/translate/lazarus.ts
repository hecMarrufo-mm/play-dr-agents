import { randomUUID } from 'node:crypto';
import { GoogleAuth, Impersonated } from 'google-auth-library';
import { env } from '../../config/env';
import { logger } from '../../lib/logger';
import type { TranslateBatchInput, TranslationProvider } from './provider';

const SCOPE = 'https://www.googleapis.com/auth/localizationpartner';

interface TranslateFileResponse {
  translatedFiles?: { targetLanguageCode: string; translatedText: string }[];
}

/**
 * Google Localizer ("Lazarus") API provider — kept for when the project's
 * GWCID/dev account is allow-listed for localizer.googleapis.com. The runtime SA
 * impersonates LOCALIZER_PRINCIPAL for the localizationpartner scope. The API
 * takes one source text per call, so batching loops the texts.
 */
export class LazarusTranslationProvider implements TranslationProvider {
  readonly name = 'lazarus';
  private readonly auth = new GoogleAuth();

  async translate({ texts, targetLangs, contentType }: TranslateBatchInput): Promise<Record<string, string[]>> {
    const token = await this.accessToken();
    const out: Record<string, string[]> = {};
    for (const lang of targetLangs) out[lang] = [];
    for (const text of texts) {
      const map = await this.translateFile(token, text, targetLangs, contentType);
      for (const lang of targetLangs) out[lang].push(map[lang] ?? '');
    }
    return out;
  }

  private async accessToken(): Promise<string> {
    const sourceClient = await this.auth.getClient();
    const impersonated = new Impersonated({
      sourceClient,
      targetPrincipal: env.LOCALIZER_PRINCIPAL,
      targetScopes: [SCOPE],
      lifetime: 3500,
    });
    const { token } = await impersonated.getAccessToken();
    if (!token) throw new Error('Failed to mint a Localizer access token');
    return token;
  }

  private async translateFile(
    token: string,
    text: string,
    targetLangs: string[],
    contentType: string,
  ): Promise<Record<string, string>> {
    const body = {
      sourceFiles: { name: `sourceFiles/${randomUUID()}`, text },
      targetLanguageCodes: targetLangs,
      contentType,
      ...(env.LOCALIZER_PRODUCT ? { product: env.LOCALIZER_PRODUCT } : {}),
    };
    const res = await fetch(`${env.LOCALIZER_ENDPOINT}/v1:translateFile`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      const detail = await res.text().catch(() => '');
      logger.error('Localizer API error', { status: res.status, detail: detail.slice(0, 300) });
      throw new Error(`Localizer API ${res.status}: ${detail.slice(0, 200)}`);
    }
    const data = (await res.json()) as TranslateFileResponse;
    const out: Record<string, string> = {};
    for (const file of data.translatedFiles ?? []) out[file.targetLanguageCode] = file.translatedText;
    return out;
  }
}
