import { env } from '../config/env';
import { GeminiProvider } from './gemini';

/** A file made available to the model as context. */
export interface LlmFile {
  filename: string;
  mimeType: string;
  /** Pre-extracted markdown/text (preferred — set at upload time). */
  text?: string;
  /** Raw bytes, used for natively-understood formats (e.g. images) when no text exists. */
  data?: Buffer;
}

/** One prior turn of conversation passed as context. */
export interface LlmTurn {
  role: 'user' | 'assistant';
  content: string;
}

export interface LlmGenerateInput {
  /** The agent's instructions (system prompt). */
  systemInstruction: string;
  /** Selected prior conversation turns, in chronological order. */
  history: LlmTurn[];
  /** The new user prompt. */
  prompt: string;
  /** Files attached to the agent, supplied as model context. */
  files?: LlmFile[];
  /** Override the model for this call (e.g. a per-agent choice). Falls back to the default. */
  model?: string;
}

/** Selectable models surfaced in the per-agent dropdown (GET /api/models). Edit to taste. */
export const AVAILABLE_MODELS: { id: string; label: string }[] = [
  { id: 'gemini-3.5-flash', label: 'Gemini 3.5 Flash — fast, great default' },
  { id: 'gemini-2.5-pro', label: 'Gemini 2.5 Pro — most capable' },
  { id: 'gemini-2.5-flash', label: 'Gemini 2.5 Flash — balanced' },
  { id: 'gemini-2.0-flash', label: 'Gemini 2.0 Flash — lightweight' },
];

/**
 * Thin interface over a chat LLM. Only Gemini is implemented today; the rest of
 * the app depends on this interface so the provider can be swapped later.
 */
export interface LlmProvider {
  /** Stream the model's reply as text chunks. */
  generateStream(input: LlmGenerateInput): AsyncIterable<string>;
  /** Non-streaming convenience: the full reply as a string (used by tools). */
  generateText(input: LlmGenerateInput): Promise<string>;
}

function build(): LlmProvider {
  // Only Gemini is implemented. Add other providers behind this switch.
  return new GeminiProvider(env.GEMINI_API_KEY, env.GEMINI_MODEL);
}

export const llm: LlmProvider = build();
