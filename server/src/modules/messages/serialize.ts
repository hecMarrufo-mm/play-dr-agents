import type { Message } from '@prisma/client';

export interface MessageAuthor {
  id: string;
  name: string;
  email: string;
  avatarUrl: string | null;
}

export type MessageWithAuthor = Message & { author: MessageAuthor | null };

/** Wire shape of a message (matches the client `Message` type). */
export interface SerializedMessage {
  id: string;
  agentId: string;
  role: 'user' | 'assistant';
  content: string;
  referencedMessageIds: string[];
  createdAt: string;
  author: MessageAuthor | null;
}

export function serializeMessage(m: MessageWithAuthor): SerializedMessage {
  return {
    id: m.id,
    agentId: m.agentId,
    role: m.role === 'ASSISTANT' ? 'assistant' : 'user',
    content: m.content,
    referencedMessageIds: m.referencedMessageIds,
    createdAt: m.createdAt.toISOString(),
    author: m.author,
  };
}
