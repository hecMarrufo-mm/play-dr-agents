import { useEffect, useRef, useState, type ChangeEvent } from 'react';
import { api, ApiError } from '../api/client';
import type { FileSummary, UserSummary } from '../types';
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

/** Small round avatar for an uploader, mirroring the Layout fallback pattern. */
function UploaderChip({ user }: { user: UserSummary }) {
  return (
    <span className="row" style={{ gap: 8 }}>
      {user.avatarUrl ? (
        <img src={user.avatarUrl} alt="" className="avatar" referrerPolicy="no-referrer" />
      ) : (
        <span className="avatar avatar-fallback">{user.name.charAt(0).toUpperCase()}</span>
      )}
      <span>{user.name}</span>
    </span>
  );
}

/**
 * The shared, platform-wide file library (`/files`). Anyone can upload a file
 * and reuse it in any agent. Files can be deleted by their uploader or an admin
 * (the server enforces this too).
 */
export default function FileLibraryPage() {
  const { user } = useAuth();

  const [files, setFiles] = useState<FileSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [uploading, setUploading] = useState(false);
  const [uploadError, setUploadError] = useState<string | null>(null);
  const [deletingId, setDeletingId] = useState<string | null>(null);

  const fileInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    (async () => {
      try {
        const list = await api.files.list();
        if (!cancelled) setFiles(list);
      } catch (err) {
        if (!cancelled) {
          setError(err instanceof ApiError ? err.message : 'Failed to load the file library.');
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  async function handleUpload(e: ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    // Always reset the input so the same file can be picked again later.
    e.target.value = '';
    if (!file) return;

    setUploadError(null);
    setUploading(true);
    try {
      const uploaded = await api.files.upload(file);
      setFiles((prev) => [uploaded, ...prev]);
    } catch (err) {
      setUploadError(err instanceof ApiError ? err.message : 'Upload failed.');
    } finally {
      setUploading(false);
    }
  }

  async function handleDelete(file: FileSummary) {
    const ok = window.confirm(
      `Delete "${file.filename}"? This removes it from the shared library` +
        (file.agentCount > 0
          ? ` and from ${file.agentCount} agent${file.agentCount === 1 ? '' : 's'} using it.`
          : '.'),
    );
    if (!ok) return;

    setUploadError(null);
    setDeletingId(file.id);
    try {
      await api.files.remove(file.id);
      setFiles((prev) => prev.filter((f) => f.id !== file.id));
    } catch (err) {
      setUploadError(err instanceof ApiError ? err.message : 'Failed to delete file.');
    } finally {
      setDeletingId(null);
    }
  }

  const canDelete = (file: FileSummary) =>
    Boolean(user && (user.id === file.uploader.id || user.role === 'ADMIN'));

  return (
    <div className="page">
      <div className="page-header">
        <div>
          <h1 className="page-title">Shared file library</h1>
          <p className="page-subtitle">
            Files are shared platform-wide — anyone can reuse them in any agent.
          </p>
        </div>
        <div className="row" style={{ gap: 10 }}>
          {uploading && <span className="spinner" aria-label="Uploading" />}
          <input
            ref={fileInputRef}
            type="file"
            onChange={handleUpload}
            disabled={uploading}
            style={{ display: 'none' }}
          />
          <button
            className="btn btn-primary"
            onClick={() => fileInputRef.current?.click()}
            disabled={uploading}
          >
            {uploading ? 'Uploading…' : '↑ Upload file'}
          </button>
        </div>
      </div>

      {uploadError && <div className="error-banner">{uploadError}</div>}

      {loading ? (
        <div className="centered">
          <span className="spinner" aria-label="Loading" />
        </div>
      ) : error ? (
        <div className="error-banner">{error}</div>
      ) : files.length === 0 ? (
        <div className="card">
          <div className="empty-state">
            <h3 style={{ marginBottom: 6 }}>No files yet</h3>
            <p style={{ marginBottom: 18 }}>
              Upload a file to share it across the platform. Anyone can attach it to an agent.
            </p>
            <button
              className="btn btn-primary"
              onClick={() => fileInputRef.current?.click()}
              disabled={uploading}
            >
              {uploading ? 'Uploading…' : '↑ Upload your first file'}
            </button>
          </div>
        </div>
      ) : (
        <div className="card" style={{ overflowX: 'auto' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 14 }}>
            <thead>
              <tr style={{ textAlign: 'left', color: 'var(--text-muted)' }}>
                <th style={th}>File</th>
                <th style={th}>Type</th>
                <th style={{ ...th, textAlign: 'right' }}>Size</th>
                <th style={th}>Uploaded by</th>
                <th style={th}>Usage</th>
                <th style={th}>Added</th>
                <th style={{ ...th, textAlign: 'right' }} aria-label="Actions" />
              </tr>
            </thead>
            <tbody>
              {files.map((file) => (
                <tr key={file.id} style={{ borderTop: '1px solid var(--border)' }}>
                  <td style={{ ...td, fontWeight: 550, maxWidth: 280 }}>
                    <a
                      href={api.files.contentUrl(file.id)}
                      target="_blank"
                      rel="noreferrer"
                      style={{ color: 'var(--accent)', wordBreak: 'break-word' }}
                    >
                      {file.filename}
                    </a>
                  </td>
                  <td style={td}>
                    <span className="badge">{file.mimeType}</span>
                  </td>
                  <td style={{ ...td, textAlign: 'right', whiteSpace: 'nowrap' }} className="muted">
                    {formatBytes(file.size)}
                  </td>
                  <td style={td}>
                    <UploaderChip user={file.uploader} />
                  </td>
                  <td style={td}>
                    <span className="badge badge-accent">
                      Used by {file.agentCount} agent{file.agentCount === 1 ? '' : 's'}
                    </span>
                  </td>
                  <td style={{ ...td, whiteSpace: 'nowrap' }} className="muted">
                    {new Date(file.createdAt).toLocaleDateString()}
                  </td>
                  <td style={{ ...td, textAlign: 'right', whiteSpace: 'nowrap' }}>
                    {canDelete(file) && (
                      <button
                        className="btn btn-danger btn-sm"
                        onClick={() => void handleDelete(file)}
                        disabled={deletingId === file.id}
                      >
                        {deletingId === file.id ? 'Deleting…' : 'Delete'}
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

const th: React.CSSProperties = { padding: '12px 14px', fontSize: 12.5, fontWeight: 600 };
const td: React.CSSProperties = { padding: '12px 14px', verticalAlign: 'middle' };
