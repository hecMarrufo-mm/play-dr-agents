import { GoogleGenerativeAI, type Content, type Part } from '@google/generative-ai';
import type { LlmFile, LlmGenerateInput, LlmProvider } from './index';

/** Inline small text files directly; send everything else as base64 inline data. */
function isTextLike(mimeType: string): boolean {
  return (
    mimeType.startsWith('text/') ||
    /(json|xml|csv|yaml|x-yaml|javascript|typescript|markdown)/.test(mimeType)
  );
}

function fileToPart(file: LlmFile): Part {
  // Prefer pre-extracted text (parsed once at upload).
  if (file.text != null) {
    return { text: `\n\n--- Attached file: ${file.filename} ---\n${file.text}\n--- End of ${file.filename} ---\n` };
  }
  if (file.data) {
    if (isTextLike(file.mimeType)) {
      return { text: `\n\n--- Attached file: ${file.filename} ---\n${file.data.toString('utf8')}\n--- End of ${file.filename} ---\n` };
    }
    return { inlineData: { mimeType: file.mimeType, data: file.data.toString('base64') } };
  }
  return { text: `\n\n--- Attached file: ${file.filename} (content unavailable) ---\n` };
}

export class GeminiProvider implements LlmProvider {
  private readonly client: GoogleGenerativeAI;
  private readonly model: string;

  constructor(apiKey: string, model: string) {
    this.client = new GoogleGenerativeAI(apiKey);
    this.model = model;
  }

  async *generateStream(input: LlmGenerateInput): AsyncIterable<string> {
    const model = this.client.getGenerativeModel({
      model: input.model || this.model,
      systemInstruction: input.systemInstruction || undefined,
    });

    const contents: Content[] = input.history.map((turn) => ({
      role: turn.role === 'assistant' ? 'model' : 'user',
      parts: [{ text: turn.content }],
    }));

    // Final user turn: the prompt plus any attached files as additional parts.
    const fileParts = (input.files ?? []).map(fileToPart);
    contents.push({ role: 'user', parts: [{ text: input.prompt }, ...fileParts] });

    const result = await model.generateContentStream({ contents });
    for await (const chunk of result.stream) {
      const text = chunk.text();
      if (text) yield text;
    }
  }

  async generateText(input: LlmGenerateInput): Promise<string> {
    let out = '';
    for await (const chunk of this.generateStream(input)) out += chunk;
    return out.trim();
  }
}
