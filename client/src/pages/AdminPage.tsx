import { useEffect, useState } from 'react';
import { api, ApiError } from '../api/client';
import type { Role, User } from '../types';
import { useAuth } from '../auth/AuthContext';

/**
 * Admin-only user management (route '/admin'). The route is already guarded for
 * admins. Lists everyone provisioned on the platform and lets an admin promote
 * a teammate to admin or demote them back to user. You cannot change your own
 * role — the server enforces this too.
 */
export default function AdminPage() {
  const { user: me } = useAuth();
  const [users, setUsers] = useState<User[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  // ids of rows whose role change is in flight.
  const [updatingIds, setUpdatingIds] = useState<Set<string>>(new Set());

  useEffect(() => {
    let active = true;
    setError(null);
    api.admin
      .listUsers()
      .then((list) => {
        if (active) setUsers(list);
      })
      .catch((err) => {
        if (!active) return;
        setError(err instanceof ApiError ? err.message : 'Failed to load users.');
        setUsers([]);
      });
    return () => {
      active = false;
    };
  }, []);

  async function changeRole(target: User) {
    const nextRole: Role = target.role === 'ADMIN' ? 'USER' : 'ADMIN';
    setError(null);
    setUpdatingIds((prev) => new Set(prev).add(target.id));
    try {
      const updated = await api.admin.setRole(target.id, nextRole);
      setUsers((prev) =>
        prev ? prev.map((u) => (u.id === updated.id ? updated : u)) : prev,
      );
    } catch (err) {
      setError(
        err instanceof ApiError
          ? err.message
          : `Failed to update ${target.name}'s role.`,
      );
    } finally {
      setUpdatingIds((prev) => {
        const next = new Set(prev);
        next.delete(target.id);
        return next;
      });
    }
  }

  const loading = users === null;

  const cellStyle: React.CSSProperties = {
    padding: '14px 16px',
    borderBottom: '1px solid var(--border)',
    verticalAlign: 'middle',
    textAlign: 'left',
  };
  const headStyle: React.CSSProperties = {
    padding: '12px 16px',
    borderBottom: '1px solid var(--border)',
    textAlign: 'left',
    fontSize: 12,
    fontWeight: 600,
    textTransform: 'uppercase',
    letterSpacing: '0.04em',
    color: 'var(--text-muted)',
    whiteSpace: 'nowrap',
  };

  return (
    <div className="page">
      <div className="page-header">
        <div>
          <h1 className="page-title">User management</h1>
          <p className="page-subtitle">
            Promote teammates to admin or back to user. Everyone at Monks is
            auto-provisioned on first sign-in.
          </p>
        </div>
      </div>

      {error && <div className="error-banner">{error}</div>}

      {loading ? (
        <div className="centered">
          <span className="spinner" />
        </div>
      ) : users.length === 0 ? (
        <div className="empty-state">
          <h3 style={{ marginBottom: 8 }}>No users yet</h3>
          <p>Teammates appear here the moment they sign in for the first time.</p>
        </div>
      ) : (
        <div className="card" style={{ overflow: 'hidden' }}>
          <div style={{ overflowX: 'auto' }}>
            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 14 }}>
              <thead>
                <tr>
                  <th style={headStyle}>Name</th>
                  <th style={headStyle}>Email</th>
                  <th style={headStyle}>Role</th>
                  <th style={headStyle}>Joined</th>
                  <th style={{ ...headStyle, textAlign: 'right' }}>Action</th>
                </tr>
              </thead>
              <tbody>
                {users.map((u, i) => {
                  const isSelf = u.id === me?.id;
                  const isUpdating = updatingIds.has(u.id);
                  const isAdmin = u.role === 'ADMIN';
                  const last = i === users.length - 1;
                  const rowCell: React.CSSProperties = last
                    ? { ...cellStyle, borderBottom: 'none' }
                    : cellStyle;
                  return (
                    <tr key={u.id}>
                      <td style={rowCell}>
                        <div className="row" style={{ gap: 10, minWidth: 0 }}>
                          {u.avatarUrl ? (
                            <img
                              src={u.avatarUrl}
                              alt=""
                              className="avatar"
                              referrerPolicy="no-referrer"
                            />
                          ) : (
                            <span className="avatar avatar-fallback">
                              {u.name.charAt(0).toUpperCase()}
                            </span>
                          )}
                          <span style={{ fontWeight: 550 }}>
                            {u.name}
                            {isSelf && (
                              <span className="muted" style={{ fontWeight: 400 }}>
                                {' '}
                                (you)
                              </span>
                            )}
                          </span>
                        </div>
                      </td>
                      <td style={rowCell}>
                        <span className="muted">{u.email}</span>
                      </td>
                      <td style={rowCell}>
                        <span className={isAdmin ? 'badge badge-accent' : 'badge'}>
                          {isAdmin ? 'Admin' : 'User'}
                        </span>
                      </td>
                      <td style={rowCell}>
                        <span className="muted" style={{ whiteSpace: 'nowrap' }}>
                          {new Date(u.createdAt).toLocaleDateString()}
                        </span>
                      </td>
                      <td style={{ ...rowCell, textAlign: 'right' }}>
                        {isSelf ? (
                          <div style={{ display: 'inline-block', textAlign: 'right' }}>
                            <button className="btn btn-sm" disabled>
                              {isAdmin ? 'Make user' : 'Make admin'}
                            </button>
                            <div className="hint" style={{ marginTop: 5 }}>
                              You cannot change your own role.
                            </div>
                          </div>
                        ) : (
                          <button
                            className="btn btn-sm"
                            disabled={isUpdating}
                            onClick={() => void changeRole(u)}
                          >
                            {isUpdating ? (
                              <>
                                <span className="spinner" style={{ width: 14, height: 14 }} />
                                Saving…
                              </>
                            ) : isAdmin ? (
                              'Make user'
                            ) : (
                              'Make admin'
                            )}
                          </button>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
}
