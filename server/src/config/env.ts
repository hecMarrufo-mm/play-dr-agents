import { z } from 'zod';

/**
 * Centralized, validated environment configuration.
 * Throws on startup if required variables are missing/invalid.
 */
const csv = z
  .string()
  .optional()
  .transform((v) =>
    (v ?? '')
      .split(',')
      .map((s) => s.trim().toLowerCase())
      .filter(Boolean),
  );

const schema = z.object({
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  PORT: z.coerce.number().int().positive().default(8080),
  APP_BASE_URL: z.string().url().default('http://localhost:8080'),

  DATABASE_URL: z.string().min(1, 'DATABASE_URL is required'),

  SESSION_SECRET: z.string().min(16, 'SESSION_SECRET must be at least 16 chars'),
  COOKIE_SECURE: z.enum(['auto', 'true', 'false']).default('auto'),
  SESSION_TTL_DAYS: z.coerce.number().int().positive().default(7),

  GOOGLE_CLIENT_ID: z.string().min(1, 'GOOGLE_CLIENT_ID is required'),
  GOOGLE_CLIENT_SECRET: z.string().min(1, 'GOOGLE_CLIENT_SECRET is required'),
  GOOGLE_OAUTH_REDIRECT_URI: z.string().url(),

  ALLOWED_DOMAINS: csv,
  ADMIN_EMAILS: csv,

  GEMINI_API_KEY: z.string().min(1, 'GEMINI_API_KEY is required'),
  GEMINI_MODEL: z.string().default('gemini-2.0-flash'),

  STORAGE_DRIVER: z.enum(['local', 'gcs']).default('local'),
  LOCAL_STORAGE_DIR: z.string().default('./data/uploads'),
  GCS_BUCKET: z.string().optional().default(''),
  GCS_PROJECT_ID: z.string().optional().default(''),

  MAX_UPLOAD_MB: z.coerce.number().int().positive().default(20),
  // Cap for direct-to-GCS (signed-URL) uploads, which bypass Cloud Run's ~32MB request cap.
  MAX_SIGNED_UPLOAD_MB: z.coerce.number().int().positive().default(200),

  // Identity-Aware Proxy (production front door). When enabled, the app trusts
  // IAP's verified identity instead of requiring its own OAuth handshake.
  IAP_ENABLED: z
    .string()
    .optional()
    .transform((v) => v === 'true' || v === '1'),
  // Optional: when set, the IAP JWT assertion is fully verified against this
  // audience. When empty, the app trusts the IAP-set identity header (safe
  // because the Cloud Run service only accepts traffic from IAP).
  IAP_AUDIENCE: z.string().optional().default(''),

  // Localizer (Lazarus) translation tool.
  TRANSLATE_PROVIDER: z.enum(['mock', 'lazarus', 'pathways']).default('mock'),
  LOCALIZER_ENDPOINT: z.string().default('https://localizer.googleapis.com'),
  // Privilege-bearing (allowlisted) service account email to impersonate for the
  // localizationpartner scope. Required when TRANSLATE_PROVIDER=lazarus.
  LOCALIZER_PRINCIPAL: z.string().optional().default(''),
  LOCALIZER_DEFAULT_CONTENT_TYPE: z.string().default('CONTENT_TYPE_UI'),
  LOCALIZER_PRODUCT: z.string().optional().default(''),
  // Gemini model used to produce char-limit / glossary-aware variants.
  TRANSLATE_FIT_MODEL: z.string().default('gemini-2.5-flash-lite'),

  // Monksflow Pathways translation trigger (whitelisted alternative to Localizer).
  PATHWAYS_TRIGGER_URL: z.string().optional().default(''),
  PATHWAYS_API_KEY: z.string().optional().default(''),
});

const parsed = schema.safeParse(process.env);

if (!parsed.success) {
  const issues = parsed.error.issues
    .map((i) => `  - ${i.path.join('.') || '(root)'}: ${i.message}`)
    .join('\n');
  // eslint-disable-next-line no-console
  console.error(`\n[config] Invalid environment configuration:\n${issues}\n`);
  process.exit(1);
}

const raw = parsed.data;

if (raw.ALLOWED_DOMAINS.length === 0) {
  // eslint-disable-next-line no-console
  console.error('[config] ALLOWED_DOMAINS must list at least one domain (e.g. monks.com)');
  process.exit(1);
}

if (raw.STORAGE_DRIVER === 'gcs' && !raw.GCS_BUCKET) {
  // eslint-disable-next-line no-console
  console.error('[config] STORAGE_DRIVER=gcs requires GCS_BUCKET');
  process.exit(1);
}

// A misconfigured translation provider must NOT crash the whole service — the
// Localizer is one tool. We warn here and the provider factory falls back to the
// mock translator (see tools/translate/provider.ts). This prevents a deploy that
// forgets PATHWAYS_TRIGGER_URL/PATHWAYS_API_KEY from taking the entire app down.
if (raw.TRANSLATE_PROVIDER === 'lazarus' && !raw.LOCALIZER_PRINCIPAL) {
  // eslint-disable-next-line no-console
  console.warn('[config] TRANSLATE_PROVIDER=lazarus requires LOCALIZER_PRINCIPAL — falling back to mock translator');
}

if (raw.TRANSLATE_PROVIDER === 'pathways' && (!raw.PATHWAYS_TRIGGER_URL || !raw.PATHWAYS_API_KEY)) {
  // eslint-disable-next-line no-console
  console.warn('[config] TRANSLATE_PROVIDER=pathways requires PATHWAYS_TRIGGER_URL and PATHWAYS_API_KEY — falling back to mock translator');
}

export const env = {
  ...raw,
  isProd: raw.NODE_ENV === 'production',
  cookieSecure: raw.COOKIE_SECURE === 'auto' ? raw.NODE_ENV === 'production' : raw.COOKIE_SECURE === 'true',
  maxUploadBytes: raw.MAX_UPLOAD_MB * 1024 * 1024,
  maxSignedUploadBytes: raw.MAX_SIGNED_UPLOAD_MB * 1024 * 1024,
};

export type Env = typeof env;
