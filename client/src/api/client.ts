import type {
  AgentDetail,
  AgentInput,
  AgentListItem,
  FileSummary,
  GlossaryEntry,
  GlossaryInput,
  Message,
  ModelOption,
  ReferencedMessage,
  Role,
  SendMessageInput,
  TranslateConfig,
  TranslateInput,
  TranslateRow,
  User,
  UserSummary,
} from '../types';

export class ApiError extends Error {
  status: number;
  code: string;
  constructor(status: number, code: string, message: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, {
    credentials: 'include',
    headers: { 'Content-Type': 'application/json', ...(init?.headers ?? {}) },
    ...init,
  });
  if (res.status === 204) return undefined as T;
  const text = await res.text();
  const data = text ? JSON.parse(text) : undefined;
  if (!res.ok) {
    const err = data?.error ?? {};
    throw new ApiError(res.status, err.code ?? 'error', err.message ?? res.statusText);
  }
  return data as T;
}

export interface StreamHandlers {
  /** The user's own message, echoed back with its persisted id. */
  onUser?: (message: Message) => void;
  /** Incremental assistant text. */
  onChunk: (text: string) => void;
  /** The final, persisted assistant message. */
  onDone: (message: Message) => void;
  /** A terminal error (network, auth, or model failure). */
  onError: (message: string) => void;
}

function parseSseBlock(block: string): { event: string; data: string } {
  let event = 'message';
  const dataLines: string[] = [];
  for (const line of block.split('\n')) {
    if (line.startsWith('event:')) event = line.slice(6).trim();
    else if (line.startsWith('data:')) dataLines.push(line.slice(5).trim());
  }
  return { event, data: dataLines.join('\n') };
}

export const api = {
  auth: {
    me: () => request<{ user: User | null; iap: boolean }>('/api/auth/me'),
    logout: () => request<{ ok: true }>('/api/auth/logout', { method: 'POST' }),
    loginUrl: () => '/api/auth/google',
  },

  agents: {
    list: () => request<{ agents: AgentListItem[] }>('/api/agents').then((r) => r.agents),
    get: (id: string) => request<{ agent: AgentDetail }>(`/api/agents/${id}`).then((r) => r.agent),
    create: (input: AgentInput) =>
      request<{ agent: AgentDetail }>('/api/agents', {
        method: 'POST',
        body: JSON.stringify(input),
      }).then((r) => r.agent),
    update: (id: string, input: AgentInput) =>
      request<{ agent: AgentDetail }>(`/api/agents/${id}`, {
        method: 'PATCH',
        body: JSON.stringify(input),
      }).then((r) => r.agent),
    remove: (id: string) => request<void>(`/api/agents/${id}`, { method: 'DELETE' }),
    transferOwner: (id: string, ownerId: string) =>
      request<{ agent: AgentDetail }>(`/api/agents/${id}/owner`, {
        method: 'PATCH',
        body: JSON.stringify({ ownerId }),
      }).then((r) => r.agent),
    addOwner: (id: string, userId: string) =>
      request<{ agent: AgentDetail }>(`/api/agents/${id}/owners`, {
        method: 'POST',
        body: JSON.stringify({ userId }),
      }).then((r) => r.agent),
    removeOwner: (id: string, userId: string) =>
      request<{ agent: AgentDetail }>(`/api/agents/${id}/owners/${userId}`, {
        method: 'DELETE',
      }).then((r) => r.agent),
  },

  users: {
    list: () => request<{ users: UserSummary[] }>('/api/users').then((r) => r.users),
  },

  models: {
    list: () => request<{ models: ModelOption[]; default: string }>('/api/models'),
  },

  messages: {
    /** List the thread; pass `since` (ISO) to fetch only newer messages (polling). */
    list: (agentId: string, since?: string) =>
      request<{ messages: Message[] }>(
        `/api/agents/${agentId}/messages${since ? `?since=${encodeURIComponent(since)}` : ''}`,
      ).then((r) => r.messages),

    /** Resolve arbitrary message ids (any agent) for the cross-agent context tray. */
    resolve: (ids: string[]) =>
      request<{ messages: ReferencedMessage[] }>('/api/messages/resolve', {
        method: 'POST',
        body: JSON.stringify({ ids }),
      }).then((r) => r.messages),

    /** Send a prompt and stream the reply. Returns when the stream closes. */
    async send(agentId: string, body: SendMessageInput, handlers: StreamHandlers, signal?: AbortSignal) {
      let res: Response;
      try {
        res = await fetch(`/api/agents/${agentId}/messages`, {
          method: 'POST',
          credentials: 'include',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
          signal,
        });
      } catch (err) {
        handlers.onError(err instanceof Error ? err.message : 'Network error');
        return;
      }

      if (!res.ok || !res.body) {
        const text = await res.text().catch(() => '');
        let message = res.statusText;
        try {
          message = JSON.parse(text)?.error?.message ?? message;
        } catch {
          /* keep statusText */
        }
        handlers.onError(message);
        return;
      }

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          let sep: number;
          while ((sep = buffer.indexOf('\n\n')) !== -1) {
            const block = buffer.slice(0, sep);
            buffer = buffer.slice(sep + 2);
            if (!block.trim()) continue;
            const { event, data } = parseSseBlock(block);
            const payload = data ? JSON.parse(data) : {};
            if (event === 'user') handlers.onUser?.(payload);
            else if (event === 'chunk') handlers.onChunk(payload.text ?? '');
            else if (event === 'done') handlers.onDone(payload.assistantMessage);
            else if (event === 'error') handlers.onError(payload.message ?? 'Model error');
          }
        }
      } catch (err) {
        if ((err as Error)?.name !== 'AbortError') {
          handlers.onError(err instanceof Error ? err.message : 'Stream error');
        }
      }
    },
  },

  files: {
    list: () => request<{ files: FileSummary[] }>('/api/files').then((r) => r.files),
    async upload(file: File): Promise<FileSummary> {
      const mimeType = file.type || 'application/octet-stream';

      // 1) Ask the API where to upload.
      const init = await request<
        { mode: 'signed'; uploadUrl: string; storageKey: string } | { mode: 'direct' }
      >('/api/files/upload-url', {
        method: 'POST',
        body: JSON.stringify({ filename: file.name, mimeType, size: file.size }),
      });

      // 2a) Local/dev backend can't sign URLs → multipart upload through the API.
      if (init.mode === 'direct') {
        const form = new FormData();
        form.append('file', file);
        const res = await fetch('/api/files', { method: 'POST', credentials: 'include', body: form });
        const text = await res.text();
        const data = text ? JSON.parse(text) : undefined;
        if (!res.ok) {
          throw new ApiError(res.status, data?.error?.code ?? 'error', data?.error?.message ?? 'Upload failed');
        }
        return data.file as FileSummary;
      }

      // 2b) PUT the bytes straight to GCS — bypasses the API and Cloud Run's ~32MB cap.
      const put = await fetch(init.uploadUrl, {
        method: 'PUT',
        headers: { 'Content-Type': mimeType },
        body: file,
      });
      if (!put.ok) {
        throw new ApiError(put.status, 'upload_failed', `Direct upload failed (HTTP ${put.status})`);
      }

      // 3) Finalize → records the file row and extracts text.
      return request<{ file: FileSummary }>('/api/files/finalize', {
        method: 'POST',
        body: JSON.stringify({ storageKey: init.storageKey, filename: file.name, mimeType, size: file.size }),
      }).then((r) => r.file);
    },
    remove: (id: string) => request<void>(`/api/files/${id}`, { method: 'DELETE' }),
    contentUrl: (id: string) => `/api/files/${id}/content`,
  },

  admin: {
    listUsers: () => request<{ users: User[] }>('/api/admin/users').then((r) => r.users),
    setRole: (userId: string, role: Role) =>
      request<{ user: User }>(`/api/admin/users/${userId}/role`, {
        method: 'PATCH',
        body: JSON.stringify({ role }),
      }).then((r) => r.user),
  },

  tools: {
    translateConfig: () => request<TranslateConfig>('/api/tools/translate/config'),
    translate: (input: TranslateInput) =>
      request<{ results: TranslateRow[] }>('/api/tools/translate', {
        method: 'POST',
        body: JSON.stringify(input),
      }).then((r) => r.results),
    glossary: {
      list: (lang?: string) =>
        request<{ entries: GlossaryEntry[] }>(
          `/api/tools/translate/glossary${lang ? `?lang=${encodeURIComponent(lang)}` : ''}`,
        ).then((r) => r.entries),
      save: (input: GlossaryInput) =>
        request<{ entry: GlossaryEntry }>('/api/tools/translate/glossary', {
          method: 'POST',
          body: JSON.stringify(input),
        }).then((r) => r.entry),
      remove: (id: string) =>
        request<void>(`/api/tools/translate/glossary/${id}`, { method: 'DELETE' }),
    },
  },
};
