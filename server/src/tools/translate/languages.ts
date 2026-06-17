/** Target languages offered by the Localizer tool (BCP-47 codes, as the API expects). */
export interface Language {
  code: string;
  name: string;
}

export const LANGUAGES: Language[] = [
  { code: 'es-ES', name: 'Spanish (Spain)' },
  { code: 'es-419', name: 'Spanish (Latin America)' },
  { code: 'pt-BR', name: 'Portuguese (Brazil)' },
  { code: 'pt-PT', name: 'Portuguese (Portugal)' },
  { code: 'fr-FR', name: 'French' },
  { code: 'fr-CA', name: 'French (Canada)' },
  { code: 'de-DE', name: 'German' },
  { code: 'it-IT', name: 'Italian' },
  { code: 'nl-NL', name: 'Dutch' },
  { code: 'pl-PL', name: 'Polish' },
  { code: 'ru-RU', name: 'Russian' },
  { code: 'tr-TR', name: 'Turkish' },
  { code: 'ar', name: 'Arabic' },
  { code: 'he-IL', name: 'Hebrew' },
  { code: 'hi-IN', name: 'Hindi' },
  { code: 'ja-JP', name: 'Japanese' },
  { code: 'ko-KR', name: 'Korean' },
  { code: 'zh-CN', name: 'Chinese (Simplified)' },
  { code: 'zh-TW', name: 'Chinese (Traditional)' },
  { code: 'th-TH', name: 'Thai' },
  { code: 'vi-VN', name: 'Vietnamese' },
  { code: 'id-ID', name: 'Indonesian' },
  { code: 'sv-SE', name: 'Swedish' },
  { code: 'da-DK', name: 'Danish' },
  { code: 'fi-FI', name: 'Finnish' },
  { code: 'nb-NO', name: 'Norwegian (Bokmål)' },
  { code: 'cs-CZ', name: 'Czech' },
  { code: 'el-GR', name: 'Greek' },
  { code: 'uk-UA', name: 'Ukrainian' },
  { code: 'ro-RO', name: 'Romanian' },
];

export function languageName(code: string): string {
  return LANGUAGES.find((l) => l.code === code)?.name ?? code;
}

/** contentType enum accepted by the Localizer API. */
export const CONTENT_TYPES = [
  'CONTENT_TYPE_UI',
  'CONTENT_TYPE_MARKETING',
  'CONTENT_TYPE_LEGAL',
  'CONTENT_TYPE_API_TECHNICAL',
  'CONTENT_TYPE_HELP_CENTER',
  'CONTENT_TYPE_OTHER',
] as const;
