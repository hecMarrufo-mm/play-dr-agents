// Wire types shared across the client. These mirror exactly what the server's
// API returns (see server/src/modules/*). Dates are ISO-8601 strings.

export type Role = 'USER' | 'ADMIN';

/** Compact identity used for owners, authors, and uploaders. */
export interface UserSummary {
  id: string;
  name: string;
  email: string;
  avatarUrl: string | null;
}

/** Full user record (GET /api/auth/me, GET /api/admin/users). */
export interface User extends UserSummary {
  role: Role;
  createdAt: string;
}

/** A file in the shared, platform-wide library. */
export interface FileSummary {
  id: string;
  filename: string;
  mimeType: string;
  size: number;
  createdAt: string;
  uploader: UserSummary;
  /** How many agents reference this file. */
  agentCount: number;
  /** Whether the file was parsed to text/markdown for use as context. */
  hasExtractedText: boolean;
}

/** Gallery list item (GET /api/agents). */
export interface AgentListItem {
  id: string;
  title: string;
  description: string;
  owner: UserSummary;
  createdAt: string;
  updatedAt: string;
  messageCount: number;
  fileCount: number;
  /** Timestamp of the most recent message, or updatedAt if none. */
  lastActivityAt: string;
}

/** Full agent (GET /api/agents/:id). */
export interface AgentDetail {
  id: string;
  title: string;
  description: string;
  instructions: string;
  /** Gemini model id, or null to use the server default. */
  model: string | null;
  owner: UserSummary;
  /** Additional owners who can also manage the agent (beyond the primary owner). */
  coOwners: UserSummary[];
  createdAt: string;
  updatedAt: string;
  messageCount: number;
  lastActivityAt: string;
  files: FileSummary[];
}

/** A single message in an agent's shared thread. author is null for assistant. */
export interface Message {
  id: string;
  agentId: string;
  role: 'user' | 'assistant';
  content: string;
  referencedMessageIds: string[];
  createdAt: string;
  author: UserSummary | null;
}

/** Body for creating/updating an agent. */
export interface AgentInput {
  title: string;
  description: string;
  instructions: string;
  fileIds: string[];
  /** Gemini model id; empty string = use the server default. */
  model: string;
}

/** A selectable model for the per-agent dropdown (GET /api/models). */
export interface ModelOption {
  id: string;
  label: string;
}

/** A message resolved for the cross-agent context tray (carries its source agent's title). */
export interface ReferencedMessage extends Message {
  agentTitle: string;
}

// ---- Localizer tool ----
export interface Language {
  code: string;
  name: string;
}

export interface TranslateConfig {
  languages: Language[];
  contentTypes: string[];
  defaultContentType: string;
  provider: string;
}

export interface TranslateCell {
  lang: string;
  api: string;
  apiLen: number;
  fits: boolean;
  variant: string | null;
  variantLen: number | null;
  glossaryApplied: string[];
}

export interface TranslateRow {
  source: string;
  translations: TranslateCell[];
}

export interface TranslateInput {
  texts: string[];
  targetLangs: string[];
  maxChars?: number;
  contentType?: string;
}

export interface GlossaryEntry {
  id: string;
  sourceTerm: string;
  targetLang: string;
  preferredTranslation: string;
  note: string;
  createdAt: string;
  createdBy: UserSummary | null;
}

export interface GlossaryInput {
  sourceTerm: string;
  targetLang: string;
  preferredTranslation: string;
  note?: string;
}

/** Body for sending a prompt. */
export interface SendMessageInput {
  content: string;
  includeHistory: boolean;
  referencedMessageIds: string[];
}
