import { useEffect, useRef, useState, type ChangeEvent, type FormEvent } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { api, ApiError } from '../api/client';
import type { AgentInput, FileSummary, ModelOption } from '../types';
import { useAuth } from '../auth/AuthContext';

/** Human-readable file size from a byte count. */
function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.min(units.length - 1, Math.floor(Math.log(bytes) / Math.log(1024)));
  const value = bytes / Math.pow(1024, i);
  const rounded = i === 0 ? value : Math.round(value * 10) / 10;
  return `${rounded} ${units[i]}`;
}

/**
 * Create or edit an agent. Same component backs both `/agents/new`
 * (no `:id`) and `/agents/:id/edit`. Editing is owner-only — non-owners
 * are bounced to the agent's chat (the server enforces this too).
 */
export default function CreateEditAgentPage() {
  const { id } = useParams();
  const isEdit = Boolean(id);
  const { user } = useAuth();
  const navigate = useNavigate();

  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [instructions, setInstructions] = useState('');
  const [fileIds, setFileIds] = useState<string[]>([]);
  const [library, setLibrary] = useState<FileSummary[]>([]);
  const [model, setModel] = useState('');
  const [models, setModels] = useState<ModelOption[]>([]);
  const [defaultModel, setDefaultModel] = useState('');

  const [initializing, setInitializing] = useState(true);
  const [saving, setSaving] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [canSave, setCanSave] = useState(false);

  const fileInputRef = useRef<HTMLInputElement>(null);

  // Load the shared library, and (when editing) the agent to prefill.
  useEffect(() => {
    let cancelled = false;
    setInitializing(true);
    setError(null);

    (async () => {
      try {
        const libraryPromise = api.files.list();
        const modelsPromise = api.models.list();
        if (isEdit && id) {
          const agent = await api.agents.get(id);
          if (cancelled) return;
          // Owner-only edit: redirect everyone else to the chat view.
          if (user && user.id !== agent.owner.id) {
            navigate(`/agents/${id}`, { replace: true });
            return;
          }
          setTitle(agent.title);
          setDescription(agent.description);
          setInstructions(agent.instructions);
          setFileIds(agent.files.map((f) => f.id));
          setModel(agent.model ?? '');
        }
        const [files, modelInfo] = await Promise.all([libraryPromise, modelsPromise]);
        if (cancelled) return;
        setLibrary(files);
        setModels(modelInfo.models);
        setDefaultModel(modelInfo.default);
      } catch (err) {
        if (cancelled) return;
        setError(err instanceof ApiError ? err.message : 'Failed to load. Please try again.');
      } finally {
        if (!cancelled) setInitializing(false);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [id, isEdit, user, navigate]);

  useEffect(() => {
    const hasTitle = title.trim().length > 0;
    const hasDescription = description.trim().length > 0;
    const hasInstructions = instructions.trim().length > 0;
    setCanSave(!saving && hasTitle && hasDescription && hasInstructions);
  }, [saving, title, description, instructions]);

  function toggleFile(fileId: string) {
    setFileIds((prev) =>
      prev.includes(fileId) ? prev.filter((x) => x !== fileId) : [...prev, fileId],
    );
  }

  async function handleUpload(e: ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    // Always clear the native input so the same file can be re-picked.
    e.target.value = '';
    if (!file) return;

    setUploading(true);
    setError(null);
    try {
      const uploaded = await api.files.upload(file);
      setLibrary((prev) => [uploaded, ...prev.filter((f) => f.id !== uploaded.id)]);
      setFileIds((prev) => (prev.includes(uploaded.id) ? prev : [...prev, uploaded.id]));
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Upload failed. Please try again.');
    } finally {
      setUploading(false);
    }
  }

  async function handleSave(e: FormEvent) {
    e.preventDefault();
    if (saving || !title.trim()) return;

    const input: AgentInput = {
      title: title.trim(),
      description: description.trim(),
      instructions,
      fileIds,
      model,
    };

    setSaving(true);
    setError(null);
    try {
      if (isEdit && id) {
        await api.agents.update(id, input);
        navigate(`/agents/${id}`);
      } else {
        const created = await api.agents.create(input);
        navigate(`/agents/${created.id}`);
      }
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Failed to save. Please try again.');
      setSaving(false);
    }
  }

  if (initializing) {
    return (
      <div className="centered">
        <span className="spinner" aria-label="Loading" />
      </div>
    );
  }

  return (
    <div className="page">
      <div className="page-header">
        <div>
          <h1 className="page-title">
            {isEdit ? 'Edit agent' : 'New agent'}
          </h1>
          <p className="page-subtitle">
            An agent is like a ported Gemini Gem: its instructions steer how it responds, and the
            files you attach give it shared reference material the whole team can build on.
          </p>
        </div>
      </div>

      {error && <div className="error-banner">{error}</div>}

      <form onSubmit={handleSave}>
        <div className="card" style={{ padding: 24 }}>
          <div className="field">
            <label className="label" htmlFor="agent-title">
              Title
            </label>
            <input
              id="agent-title"
              className="input"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder="e.g. Brand Voice Assistant"
              maxLength={120}
              required
              autoFocus
            />
          </div>

          <div className="field">
            <label className="label" htmlFor="agent-description">
              Description
            </label>
            <textarea
              id="agent-description"
              className="textarea"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="A short summary of what this agent helps with."
              rows={2}
              style={{ minHeight: 60 }}
            />
          </div>

          <div className="field">
            <label className="label" htmlFor="agent-instructions">
              Instructions (system prompt)
            </label>
            <textarea
              id="agent-instructions"
              className="textarea"
              value={instructions}
              onChange={(e) => setInstructions(e.target.value)}
              placeholder="You are a helpful assistant that…"
              rows={10}
            />
            <p className="hint">
              These instructions steer the agent on every message, like a Gemini Gem.
            </p>
          </div>

          <div className="field">
            <label className="label" htmlFor="agent-model">
              Model
            </label>
            <select
              id="agent-model"
              className="select"
              value={model}
              onChange={(e) => setModel(e.target.value)}
            >
              <option value="">Default{defaultModel ? ` (${defaultModel})` : ''}</option>
              {models.map((m) => (
                <option key={m.id} value={m.id}>
                  {m.label}
                </option>
              ))}
            </select>
            <p className="hint">Which Gemini model answers for this agent.</p>
          </div>

          <div className="field" style={{ marginBottom: 0 }}>
            <span className="label">Attached files (shared library)</span>
            <p className="hint" style={{ marginTop: 0, marginBottom: 12 }}>
              Files live in one shared, platform-wide library — uploads here are reusable by any
              agent across the team.
            </p>

            <div
              className="row"
              style={{ flexWrap: 'wrap', gap: 12, marginBottom: 14 }}
            >
              <input
                ref={fileInputRef}
                type="file"
                onChange={handleUpload}
                disabled={uploading}
                style={{ fontSize: 13 }}
              />
              {uploading && (
                <span className="row" style={{ gap: 8 }}>
                  <span className="spinner" aria-label="Uploading" />
                  <span className="muted" style={{ fontSize: 13 }}>
                    Uploading…
                  </span>
                </span>
              )}
            </div>

            {library.length === 0 ? (
              <p className="muted" style={{ fontSize: 13 }}>
                No files in the library yet. Upload one above to attach it.
              </p>
            ) : (
              <div
                style={{
                  display: 'flex',
                  flexDirection: 'column',
                  gap: 8,
                  maxHeight: 320,
                  overflowY: 'auto',
                }}
              >
                {library.map((file) => {
                  const selected = fileIds.includes(file.id);
                  return (
                    <label
                      key={file.id}
                      className="checkbox-label"
                      style={{
                        display: 'flex',
                        alignItems: 'center',
                        gap: 12,
                        padding: '10px 12px',
                        borderRadius: 'var(--radius-sm)',
                        border: '1px solid var(--border)',
                        background: selected ? 'var(--accent-soft)' : 'var(--surface)',
                        color: 'var(--text)',
                        cursor: 'pointer',
                      }}
                    >
                      <input
                        type="checkbox"
                        className="message-checkbox"
                        checked={selected}
                        onChange={() => toggleFile(file.id)}
                      />
                      <span
                        style={{
                          flex: 1,
                          minWidth: 0,
                          overflow: 'hidden',
                          textOverflow: 'ellipsis',
                          whiteSpace: 'nowrap',
                          fontWeight: 550,
                        }}
                        title={file.filename}
                      >
                        {file.filename}
                      </span>
                      <span className="muted" style={{ fontSize: 12.5, whiteSpace: 'nowrap' }}>
                        {formatBytes(file.size)} · by {file.uploader.name}
                      </span>
                      {selected && <span className="badge badge-accent">Attached</span>}
                    </label>
                  );
                })}
              </div>
            )}

            {fileIds.length > 0 && (
              <p className="hint">
                {fileIds.length} file{fileIds.length === 1 ? '' : 's'} attached to this agent.
              </p>
            )}
          </div>
        </div>

        <div className="row" style={{ marginTop: 20 }}>
          <button type="submit" className="btn btn-primary" disabled={!canSave}>
            {saving && <span className="spinner" aria-hidden="true" />}
            {saving ? 'Saving…' : isEdit ? 'Save changes' : 'Create agent'}
          </button>
          <button
            type="button"
            className="btn btn-ghost"
            onClick={() => navigate(isEdit && id ? `/agents/${id}` : '/')}
            disabled={saving}
          >
            Cancel
          </button>
        </div>
      </form>
    </div>
  );
}
