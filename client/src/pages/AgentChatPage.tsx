import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent,
} from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { api, ApiError } from '../api/client';
import { useAuth } from '../auth/AuthContext';
import type { AgentDetail, AgentListItem, Message, ReferencedMessage, UserSummary } from '../types';
import { Markdown } from '../components/Markdown';

/**
 * AgentChatPage — the per-agent SHARED conversation thread (route /agents/:id).
 *
 * This is the product centerpiece: a single chat thread that every user of the
 * platform sees and contributes to. Because authorship is shared, each message
 * makes its author explicit, and users can hand-pick earlier messages as
 * referenced context (which overrides "include full history").
 */

/** Local id for the temporary, in-flight assistant message while streaming. */
const STREAMING_ID = '__streaming__';

/** Compact relative-ish time with an absolute tooltip via title attr. */
function formatTime(iso: string): string {
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return '';
  const diffSec = Math.round((Date.now() - then) / 1000);
  if (diffSec < 45) return 'just now';
  if (diffSec < 90) return '1 min ago';
  if (diffSec < 3600) return `${Math.round(diffSec / 60)} min ago`;
  if (diffSec < 7200) return '1 hr ago';
  if (diffSec < 86400) return `${Math.round(diffSec / 3600)} hr ago`;
  return new Date(iso).toLocaleString();
}

/** Small round avatar mirroring Layout's fallback pattern. */
function Avatar({ user }: { user: UserSummary | null }) {
  if (user?.avatarUrl) {
    return <img src={user.avatarUrl} alt="" className="avatar" referrerPolicy="no-referrer" />;
  }
  const initial = (user?.name ?? '?').charAt(0).toUpperCase();
  return <span className="avatar avatar-fallback">{initial}</span>;
}

export default function AgentChatPage() {
  const { id } = useParams();
  const navigate = useNavigate();
  const { user } = useAuth();

  // ----- core data -----
  const [agent, setAgent] = useState<AgentDetail | null>(null);
  const [messages, setMessages] = useState<Message[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);

  // ----- composer / streaming -----
  const [text, setText] = useState('');
  const [includeHistory, setIncludeHistory] = useState(true);
  const [selected, setSelected] = useState<Set<string>>(() => new Set());
  const [streaming, setStreaming] = useState(false);
  const [streamingText, setStreamingText] = useState('');
  const [sendError, setSendError] = useState<string | null>(null);

  // ----- cross-agent context picker -----
  const [showPicker, setShowPicker] = useState(false);
  const [pickerAgents, setPickerAgents] = useState<AgentListItem[]>([]);
  const [pickerAgentId, setPickerAgentId] = useState('');
  const [pickerMessages, setPickerMessages] = useState<Message[]>([]);
  const [pickerLoading, setPickerLoading] = useState(false);
  // Resolved details for referenced messages that live in OTHER threads (for the tray).
  const [refCache, setRefCache] = useState<Record<string, ReferencedMessage>>({});

  // ----- delete modal -----
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);

  // ----- transfer ownership -----
  const [showOwners, setShowOwners] = useState(false);
  const [users, setUsers] = useState<UserSummary[]>([]);
  const [addCoOwnerId, setAddCoOwnerId] = useState('');
  const [transferTo, setTransferTo] = useState('');
  const [ownersBusy, setOwnersBusy] = useState(false);
  const [ownersError, setOwnersError] = useState<string | null>(null);

  // ----- refs -----
  const threadBottomRef = useRef<HTMLDivElement | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  // Latest accumulated stream text, mirrored for use during an aborted send
  // (the API client swallows AbortError, so onDone/onError won't fire).
  const streamingTextRef = useRef('');
  const finalizedRef = useRef(false);

  const isPrimaryOwner = !!user && !!agent && (user.id === agent.owner.id || user.role === 'ADMIN');
  const canManage =
    !!user && !!agent && (isPrimaryOwner || agent.coOwners.some((c) => c.id === user.id));

  // --- load agent + messages in parallel on mount / id change ---
  useEffect(() => {
    if (!id) {
      setLoadError('No agent specified.');
      setLoading(false);
      return;
    }
    let alive = true;
    setLoading(true);
    setLoadError(null);
    Promise.all([api.agents.get(id), api.messages.list(id)])
      .then(([detail, msgs]) => {
        if (!alive) return;
        setAgent(detail);
        setMessages(msgs);
      })
      .catch((err) => {
        if (!alive) return;
        setLoadError(err instanceof ApiError ? err.message : 'Failed to load this conversation.');
      })
      .finally(() => {
        if (alive) setLoading(false);
      });
    return () => {
      alive = false;
    };
  }, [id]);

  // Reset transient composer/selection state when switching agents.
  useEffect(() => {
    setText('');
    setSelected(new Set());
    setIncludeHistory(true);
    setStreaming(false);
    setStreamingText('');
    streamingTextRef.current = '';
    setSendError(null);
    return () => {
      abortRef.current?.abort();
    };
  }, [id]);

  // --- auto-scroll to the newest content ---
  useLayoutEffect(() => {
    threadBottomRef.current?.scrollIntoView({ behavior: 'smooth', block: 'end' });
  }, [messages, streamingText, streaming]);

  // --- live updates: poll for messages other people add to this shared thread ---
  useEffect(() => {
    if (!id) return;
    const tick = async () => {
      if (document.visibilityState !== 'visible' || streaming) return;
      const last = messages[messages.length - 1];
      try {
        const fresh = await api.messages.list(id, last?.createdAt);
        if (fresh.length === 0) return;
        setMessages((prev) => {
          const seen = new Set(prev.map((m) => m.id));
          const add = fresh.filter((m) => !seen.has(m.id));
          return add.length ? [...prev, ...add] : prev;
        });
      } catch {
        /* ignore transient polling errors */
      }
    };
    const handle = window.setInterval(() => void tick(), 4000);
    return () => window.clearInterval(handle);
  }, [id, messages, streaming]);

  // --- resolve referenced messages from OTHER threads so the tray can show them ---
  useEffect(() => {
    const threadIds = new Set(messages.map((m) => m.id));
    const missing = Array.from(selected).filter((mid) => !threadIds.has(mid) && !refCache[mid]);
    if (missing.length === 0) return;
    let alive = true;
    api.messages
      .resolve(missing)
      .then((res) => {
        if (!alive) return;
        setRefCache((prev) => {
          const next = { ...prev };
          for (const m of res) next[m.id] = m;
          return next;
        });
      })
      .catch(() => undefined);
    return () => {
      alive = false;
    };
  }, [selected, messages, refCache]);

  // --- selection helpers ---
  const toggleSelected = useCallback((messageId: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(messageId)) next.delete(messageId);
      else next.add(messageId);
      return next;
    });
  }, []);

  const clearSelection = useCallback(() => setSelected(new Set()), []);

  const hasSelection = selected.size > 0;

  // --- sending ---
  const canSend = text.trim().length > 0 && !streaming && !!id;

  const handleSend = useCallback(async () => {
    const content = text.trim();
    if (!content || streaming || !id) return;

    setSendError(null);
    setStreaming(true);
    setStreamingText('');
    streamingTextRef.current = '';
    finalizedRef.current = false;

    const controller = new AbortController();
    abortRef.current = controller;

    const body = {
      content,
      includeHistory: hasSelection ? false : includeHistory,
      referencedMessageIds: Array.from(selected),
    };

    await api.messages.send(
      id,
      body,
      {
        onUser: (m) => {
          setMessages((prev) => [...prev, m]);
          setText('');
          setSelected(new Set());
        },
        onChunk: (t) => {
          streamingTextRef.current += t;
          setStreamingText((prev) => prev + t);
        },
        onDone: (m) => {
          finalizedRef.current = true;
          setMessages((prev) => [...prev, m]);
          setStreamingText('');
          streamingTextRef.current = '';
          setStreaming(false);
        },
        onError: (msg) => {
          finalizedRef.current = true;
          setSendError(msg);
          setStreamingText('');
          streamingTextRef.current = '';
          setStreaming(false);
        },
      },
      controller.signal,
    );

    // If the stream was aborted, the client swallows AbortError and neither
    // onDone nor onError fired. Preserve any partial reply so the shared thread
    // reflects what was actually generated, then reset streaming state.
    if (!finalizedRef.current) {
      const partial = streamingTextRef.current;
      if (partial.trim()) {
        const stopped: Message = {
          id: `local-stopped-${Date.now()}`,
          agentId: id,
          role: 'assistant',
          content: `${partial}\n\n— stopped —`,
          referencedMessageIds: [],
          createdAt: new Date().toISOString(),
          author: null,
        };
        setMessages((prev) => [...prev, stopped]);
      }
      setStreamingText('');
      streamingTextRef.current = '';
      setStreaming(false);
    }
    abortRef.current = null;
  }, [text, streaming, id, includeHistory, hasSelection, selected]);

  const handleStop = useCallback(() => {
    abortRef.current?.abort();
  }, []);

  // --- cross-agent context picker ---
  const openPicker = useCallback(async () => {
    setShowPicker(true);
    setPickerAgentId('');
    setPickerMessages([]);
    try {
      const agents = await api.agents.list();
      setPickerAgents(agents.filter((a) => a.id !== id));
    } catch {
      setPickerAgents([]);
    }
  }, [id]);

  const selectPickerAgent = useCallback(async (agentId: string) => {
    setPickerAgentId(agentId);
    setPickerMessages([]);
    if (!agentId) return;
    setPickerLoading(true);
    try {
      setPickerMessages(await api.messages.list(agentId));
    } catch {
      setPickerMessages([]);
    } finally {
      setPickerLoading(false);
    }
  }, []);

  const handleKeyDown = useCallback(
    (e: KeyboardEvent<HTMLTextAreaElement>) => {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        if (canSend) void handleSend();
      }
    },
    [canSend, handleSend],
  );

  // --- delete ---
  const handleDelete = useCallback(async () => {
    if (!id) return;
    setDeleting(true);
    setDeleteError(null);
    try {
      await api.agents.remove(id);
      navigate('/');
    } catch (err) {
      setDeleteError(err instanceof ApiError ? err.message : 'Failed to delete this agent.');
      setDeleting(false);
    }
  }, [id, navigate]);

  // --- transfer ownership ---
  const openOwners = useCallback(async () => {
    setOwnersError(null);
    setAddCoOwnerId('');
    setTransferTo('');
    setShowOwners(true);
    try {
      setUsers(await api.users.list());
    } catch {
      setUsers([]);
    }
  }, []);

  const handleAddCoOwner = useCallback(async () => {
    if (!id || !addCoOwnerId) return;
    setOwnersBusy(true);
    setOwnersError(null);
    try {
      setAgent(await api.agents.addOwner(id, addCoOwnerId));
      setAddCoOwnerId('');
    } catch (err) {
      setOwnersError(err instanceof ApiError ? err.message : 'Failed to add co-owner.');
    } finally {
      setOwnersBusy(false);
    }
  }, [id, addCoOwnerId]);

  const handleRemoveCoOwner = useCallback(
    async (userId: string) => {
      if (!id) return;
      setOwnersBusy(true);
      setOwnersError(null);
      try {
        setAgent(await api.agents.removeOwner(id, userId));
      } catch (err) {
        setOwnersError(err instanceof ApiError ? err.message : 'Failed to remove co-owner.');
      } finally {
        setOwnersBusy(false);
      }
    },
    [id],
  );

  const handleTransfer = useCallback(async () => {
    if (!id || !transferTo) return;
    setOwnersBusy(true);
    setOwnersError(null);
    try {
      setAgent(await api.agents.transferOwner(id, transferTo));
      setShowOwners(false);
    } catch (err) {
      setOwnersError(err instanceof ApiError ? err.message : 'Failed to transfer ownership.');
    } finally {
      setOwnersBusy(false);
    }
  }, [id, transferTo]);

  // --- derived render data ---
  const agentTitle = agent?.title ?? 'Agent';
  const selectedHighlight: CSSProperties = {
    outline: '2px solid var(--accent)',
    outlineOffset: '2px',
    borderRadius: '14px',
  };

  const threadIsEmpty = messages.length === 0 && !streaming;

  // Selected context messages that come from OTHER agents (shown in a tray).
  const crossAgentRefs = Array.from(selected)
    .filter((mid) => !messages.some((m) => m.id === mid))
    .map((mid) => refCache[mid])
    .filter((m): m is ReferencedMessage => Boolean(m));

  // ===================== loading / error gates =====================
  if (loading) {
    return (
      <div className="centered">
        <span className="spinner" aria-label="Loading conversation" />
      </div>
    );
  }

  if (loadError || !agent) {
    return (
      <div className="page">
        <div className="error-banner">{loadError ?? 'This conversation could not be found.'}</div>
        <Link to="/" className="btn btn-sm">
          ← Back to agents
        </Link>
      </div>
    );
  }

  // ===================== main chat =====================
  return (
    <div className="chat">
      {/* ---------- header ---------- */}
      <div className="chat-header">
        <div className="row" style={{ alignItems: 'flex-start' }}>
          <Link to="/" className="btn btn-ghost btn-sm" style={{ marginTop: 2 }} title="Back to agents">
            ←
          </Link>
          <div style={{ minWidth: 0, flex: 1 }}>
            <h2
              className="page-title"
              style={{ fontSize: 20, display: 'flex', alignItems: 'center', gap: 8 }}
            >
              <span style={{ overflow: 'hidden', textOverflow: 'ellipsis' }}>{agent.title}</span>
            </h2>
            {agent.description && (
              <div className="muted" style={{ marginTop: 4, fontSize: 14 }}>
                {agent.description}
              </div>
            )}
            <div className="muted" style={{ marginTop: 6, fontSize: 13, visibility: 'hidden'}}>
              <span
                className="user-chip"
                style={{ display: 'inline-flex', verticalAlign: 'middle', gap: 6 }}
              >
                by
                <Avatar user={agent.owner} />
                <span style={{ fontWeight: 550, color: 'var(--text)' }}>{agent.owner.name}</span>
              </span>
              {agent.model && (
                <span className="badge" style={{ marginLeft: 8 }} title="Model used by this agent">
                  {agent.model}
                </span>
              )}
            </div>

            {agent.files.length > 0 && (
              <div
                className="row"
                style={{ flexWrap: 'wrap', gap: 8, marginTop: 10 }}
                aria-label="Attached files"
              >
                {agent.files.map((file) => (
                  <a
                    key={file.id}
                    className="tag"
                    href={api.files.contentUrl(file.id)}
                    target="_blank"
                    rel="noreferrer"
                    title={`${file.filename} (${file.mimeType})`}
                  >
                    <span aria-hidden>📎</span>
                    <span
                      style={{
                        maxWidth: 220,
                        overflow: 'hidden',
                        textOverflow: 'ellipsis',
                        whiteSpace: 'nowrap',
                      }}
                    >
                      {file.filename}
                    </span>
                  </a>
                ))}
              </div>
            )}
          </div>

          {canManage && (
            <div className="row" style={{ gap: 8, flexShrink: 0 }}>
              <Link to={`/agents/${id}/edit`} className="btn btn-sm">
                Edit
              </Link>
              <button type="button" className="btn btn-sm" onClick={() => void openOwners()}>
                Owners
              </button>
              <button
                type="button"
                className="btn btn-danger btn-sm"
                onClick={() => {
                  setDeleteError(null);
                  setConfirmingDelete(true);
                }}
              >
                Delete
              </button>
            </div>
          )}
        </div>
      </div>

      {/* ---------- thread ---------- */}
      <div className="chat-thread">
        {threadIsEmpty ? (
          <div className="empty-state" style={{ margin: 'auto' }}>
            <h3 style={{ marginBottom: 6 }}>No messages yet</h3>
            <p className="muted" style={{ maxWidth: 420, margin: '0 auto' }}>
              This is a shared conversation with <strong>{agent.title}</strong>. Anything you send
              here is visible to everyone on the platform. Start the discussion below.
            </p>
          </div>
        ) : (
          <>
            {messages.map((m) => {
              const isUser = m.role === 'user';
              const authorName = isUser ? m.author?.name ?? 'Unknown user' : agent.title;
              const isSelected = selected.has(m.id);
              const isMine = isUser && !!user && m.author?.id === user.id;
              return (
                <div
                  key={m.id}
                  className={`message ${isUser ? 'user' : 'assistant'}`}
                  style={isSelected ? selectedHighlight : undefined}
                >
                  <div style={{ flexShrink: 0 }}>
                    {isUser ? (
                      <Avatar user={m.author} />
                    ) : (
                      <img
                        src="/icon.png"
                        alt=""
                        className="avatar"
                        style={{ objectFit: 'contain', background: 'var(--surface-2)' }}
                        title={agent.title}
                      />
                    )}
                  </div>
                  <div style={{ minWidth: 0 }}>
                    <div className="message-meta">
                      <span style={{ fontWeight: 600, color: 'var(--text)' }}>{authorName}</span>
                      {isMine && (
                        <span className="badge badge-accent" style={{ marginLeft: 6 }}>
                          you
                        </span>
                      )}
                      {!isUser && (
                        <span className="badge" style={{ marginLeft: 6 }}>
                          agent
                        </span>
                      )}
                      <span title={new Date(m.createdAt).toLocaleString()} style={{ marginLeft: 6 }}>
                        · {formatTime(m.createdAt)}
                      </span>
                    </div>
                    <div className="bubble">
                      {isUser ? m.content : <Markdown content={m.content} />}
                    </div>
                    {m.referencedMessageIds.length > 0 && (
                      <div className="hint" style={{ marginTop: 4 }}>
                        ↳ referenced {m.referencedMessageIds.length} earlier message
                        {m.referencedMessageIds.length === 1 ? '' : 's'} as context
                      </div>
                    )}
                    <label
                      className="checkbox-label"
                      style={{ marginTop: 6, fontSize: 12 }}
                      title="Include this message as explicit referenced context for your next prompt"
                    >
                      <input
                        type="checkbox"
                        className="message-checkbox"
                        checked={isSelected}
                        onChange={() => toggleSelected(m.id)}
                      />
                      Use as context
                    </label>
                  </div>
                </div>
              );
            })}

            {/* in-flight assistant reply */}
            {streaming && (
              <div className="message assistant" key={STREAMING_ID}>
                <div style={{ flexShrink: 0 }}>
                  <img
                    src="/icon.png"
                    alt=""
                    className="avatar"
                    style={{ objectFit: 'contain', background: 'var(--surface-2)' }}
                    title={agent.title}
                  />
                </div>
                <div style={{ minWidth: 0 }}>
                  <div className="message-meta">
                    <span style={{ fontWeight: 600, color: 'var(--text)' }}>{agent.title}</span>
                    <span className="badge" style={{ marginLeft: 6 }}>
                      agent
                    </span>
                  </div>
                  <div className="bubble">
                    {streamingText && <Markdown content={streamingText} />}
                    <span className="typing-dots" aria-label="Generating reply" style={{ marginLeft: streamingText ? 4 : 0 }}>
                      <span></span>
                      <span></span>
                      <span></span>
                    </span>
                  </div>
                </div>
              </div>
            )}
          </>
        )}
        <div ref={threadBottomRef} />
      </div>

      {/* ---------- composer ---------- */}
      <div className="composer">
        {sendError && (
          <div className="error-banner" role="alert">
            {sendError}
          </div>
        )}

        {crossAgentRefs.length > 0 && (
          <div className="row" style={{ flexWrap: 'wrap', gap: 8, marginBottom: 10 }}>
            <span className="hint" style={{ margin: 0 }}>
              From other agents:
            </span>
            {crossAgentRefs.map((m) => (
              <span key={m.id} className="tag" title={m.content}>
                <strong>{m.agentTitle}</strong>
                <span
                  className="muted"
                  style={{ maxWidth: 160, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}
                >
                  {m.content}
                </span>
                <button
                  type="button"
                  onClick={() => toggleSelected(m.id)}
                  title="Remove from context"
                  style={{ border: 'none', background: 'none', cursor: 'pointer', color: 'var(--text-muted)', padding: 0 }}
                >
                  ×
                </button>
              </span>
            ))}
          </div>
        )}

        <div className="composer-controls">
          <label className="checkbox-label" title="Send the whole thread as context to the agent">
            <input
              type="checkbox"
              checked={hasSelection ? false : includeHistory}
              disabled={hasSelection || streaming}
              onChange={(e) => setIncludeHistory(e.target.checked)}
            />
            Include full history
          </label>

          {hasSelection ? (
            <>
              <span className="badge badge-accent">{selected.size} selected as context</span>
              <button
                type="button"
                className="btn btn-ghost btn-sm"
                onClick={clearSelection}
                disabled={streaming}
              >
                Clear
              </button>
              <span className="hint" style={{ margin: 0 }}>
                Explicit selection overrides full history.
              </span>
            </>
          ) : (
            <span className="hint" style={{ margin: 0 }}>
              Tip: check messages above to reference only those.
            </span>
          )}
          <button
            type="button"
            className="btn btn-ghost btn-sm"
            onClick={() => void openPicker()}
            disabled={streaming}
            title="Pull context from another agent's conversation"
          >
            + Context from another agent
          </button>
        </div>

        <div className="composer-row">
          <textarea
            className="textarea"
            placeholder={`Message ${agentTitle}…`}
            value={text}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={handleKeyDown}
            disabled={streaming}
            rows={1}
            aria-label={`Message ${agentTitle}`}
          />
          {streaming ? (
            <button type="button" className="btn" onClick={handleStop} title="Stop generating">
              ■ Stop
            </button>
          ) : (
            <button
              type="button"
              className="btn btn-primary"
              onClick={() => void handleSend()}
              disabled={!canSend}
            >
              Send
            </button>
          )}
        </div>
        <div className="hint" style={{ marginTop: 6 }}>
          Enter to send · Shift+Enter for a new line · this thread is shared with everyone
        </div>
      </div>

      {/* ---------- manage owners modal ---------- */}
      {showOwners && (
        <div
          className="modal-overlay"
          role="dialog"
          aria-modal="true"
          onClick={() => {
            if (!ownersBusy) setShowOwners(false);
          }}
        >
          <div className="modal" style={{ maxWidth: 520, width: '100%' }} onClick={(e) => e.stopPropagation()}>
            <h3>Manage owners</h3>
            <p className="muted" style={{ marginTop: 4 }}>
              Owners and co-owners can edit, delete, and manage “{agent.title}”. Everyone else keeps
              read + chat access.
            </p>

            {ownersError && (
              <div className="error-banner" role="alert" style={{ marginTop: 12 }}>
                {ownersError}
              </div>
            )}

            <div className="field" style={{ marginTop: 14 }}>
              <span className="label">Current owners</span>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                <div className="row" style={{ gap: 8 }}>
                  <Avatar user={agent.owner} />
                  <span style={{ fontWeight: 550 }}>{agent.owner.name}</span>
                  <span className="badge badge-accent">primary</span>
                </div>
                {agent.coOwners.map((co) => (
                  <div key={co.id} className="row" style={{ gap: 8 }}>
                    <Avatar user={co} />
                    <span>{co.name}</span>
                    <span className="spacer" />
                    <button
                      type="button"
                      className="btn btn-ghost btn-sm"
                      style={{ padding: '1px 8px', fontSize: 12 }}
                      onClick={() => void handleRemoveCoOwner(co.id)}
                      disabled={ownersBusy}
                    >
                      Remove
                    </button>
                  </div>
                ))}
              </div>
            </div>

            <div className="field">
              <label className="label">Add a co-owner</label>
              <div className="row" style={{ gap: 8 }}>
                <select
                  className="select"
                  value={addCoOwnerId}
                  onChange={(e) => setAddCoOwnerId(e.target.value)}
                  style={{ flex: 1 }}
                >
                  <option value="">Choose a teammate…</option>
                  {users
                    .filter((u) => u.id !== agent.owner.id && !agent.coOwners.some((c) => c.id === u.id))
                    .map((u) => (
                      <option key={u.id} value={u.id}>
                        {u.name} ({u.email})
                      </option>
                    ))}
                </select>
                <button
                  type="button"
                  className="btn btn-sm"
                  onClick={() => void handleAddCoOwner()}
                  disabled={ownersBusy || !addCoOwnerId}
                >
                  Add
                </button>
              </div>
            </div>

            {isPrimaryOwner && (
              <div className="field" style={{ marginBottom: 0 }}>
                <label className="label">Transfer primary ownership</label>
                <div className="row" style={{ gap: 8 }}>
                  <select
                    className="select"
                    value={transferTo}
                    onChange={(e) => setTransferTo(e.target.value)}
                    style={{ flex: 1 }}
                  >
                    <option value="">Choose a teammate…</option>
                    {users
                      .filter((u) => u.id !== agent.owner.id)
                      .map((u) => (
                        <option key={u.id} value={u.id}>
                          {u.name} ({u.email})
                        </option>
                      ))}
                  </select>
                  <button
                    type="button"
                    className="btn btn-sm"
                    onClick={() => void handleTransfer()}
                    disabled={ownersBusy || !transferTo}
                  >
                    Make primary
                  </button>
                </div>
                <p className="hint" style={{ marginBottom: 0 }}>
                  The new primary takes over attribution; you keep access only if you're also a co-owner.
                </p>
              </div>
            )}

            <div className="modal-actions">
              <button
                type="button"
                className="btn btn-primary"
                onClick={() => setShowOwners(false)}
                disabled={ownersBusy}
              >
                Done
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ---------- delete confirmation modal ---------- */}
      {confirmingDelete && (
        <div
          className="modal-overlay"
          role="dialog"
          aria-modal="true"
          onClick={() => {
            if (!deleting) setConfirmingDelete(false);
          }}
        >
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <h3>Delete this agent?</h3>
            <p className="muted">
              “{agent.title}” and its entire shared conversation
              {agent.messageCount > 0 ? ` (${agent.messageCount} messages)` : ''} will be permanently
              removed for everyone. This cannot be undone.
            </p>
            {deleteError && (
              <div className="error-banner" role="alert" style={{ marginTop: 12, marginBottom: 0 }}>
                {deleteError}
              </div>
            )}
            <div className="modal-actions">
              <button
                type="button"
                className="btn btn-ghost"
                onClick={() => setConfirmingDelete(false)}
                disabled={deleting}
              >
                Cancel
              </button>
              <button
                type="button"
                className="btn btn-danger"
                onClick={() => void handleDelete()}
                disabled={deleting}
              >
                {deleting ? <span className="spinner" /> : 'Delete'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ---------- cross-agent context picker ---------- */}
      {showPicker && (
        <div className="modal-overlay" role="dialog" aria-modal="true" onClick={() => setShowPicker(false)}>
          <div className="modal" style={{ maxWidth: 640, width: '100%' }} onClick={(e) => e.stopPropagation()}>
            <h3>Add context from another agent</h3>
            <p className="muted" style={{ marginTop: 4 }}>
              Pick a conversation, then check the messages to include as context for your next prompt.
            </p>
            <div className="field" style={{ marginTop: 14 }}>
              <select
                className="select"
                value={pickerAgentId}
                onChange={(e) => void selectPickerAgent(e.target.value)}
              >
                <option value="">Choose an agent…</option>
                {pickerAgents.map((a) => (
                  <option key={a.id} value={a.id}>
                    {a.title} — {a.messageCount} messages
                  </option>
                ))}
              </select>
            </div>
            <div style={{ maxHeight: 340, overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: 8 }}>
              {pickerLoading ? (
                <div className="centered" style={{ minHeight: 80 }}>
                  <span className="spinner" />
                </div>
              ) : pickerAgentId && pickerMessages.length === 0 ? (
                <p className="muted">No messages in that conversation yet.</p>
              ) : (
                pickerMessages.map((m) => {
                  const isSel = selected.has(m.id);
                  return (
                    <label
                      key={m.id}
                      className="checkbox-label"
                      style={{
                        alignItems: 'flex-start',
                        gap: 10,
                        padding: '8px 10px',
                        border: '1px solid var(--border)',
                        borderRadius: 'var(--radius-sm)',
                        background: isSel ? 'var(--accent-soft)' : 'var(--surface)',
                        color: 'var(--text)',
                      }}
                    >
                      <input
                        type="checkbox"
                        className="message-checkbox"
                        checked={isSel}
                        onChange={() => toggleSelected(m.id)}
                      />
                      <span style={{ minWidth: 0 }}>
                        <span className="message-meta" style={{ display: 'block' }}>
                          {m.role === 'user' ? m.author?.name ?? 'User' : 'Agent'}
                        </span>
                        <span
                          style={{
                            display: 'block',
                            overflow: 'hidden',
                            textOverflow: 'ellipsis',
                            whiteSpace: 'nowrap',
                            maxWidth: 540,
                          }}
                        >
                          {m.content}
                        </span>
                      </span>
                    </label>
                  );
                })
              )}
            </div>
            <div className="modal-actions">
              <button type="button" className="btn btn-primary" onClick={() => setShowPicker(false)}>
                Done{selected.size > 0 ? ` · ${selected.size} selected` : ''}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
