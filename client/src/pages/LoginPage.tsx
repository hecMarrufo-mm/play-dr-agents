import { Navigate, useSearchParams } from 'react-router-dom';
import { useAuth } from '../auth/AuthContext';

/**
 * Public sign-in page (route '/login').
 *
 * Redirects authenticated users to the gallery. For everyone else it presents
 * the brand, a one-line pitch, and a single "Continue with Google" action that
 * kicks off the OAuth flow. Rejected sign-ins (e.g. wrong Workspace domain)
 * bounce back here with an `?error=` message, surfaced in an error banner.
 */
export default function LoginPage() {
  const { user, login, loading } = useAuth();
  const [params] = useSearchParams();

  if (loading) {
    return (
      <div className="centered" style={{ minHeight: '100vh' }}>
        <span className="spinner" />
      </div>
    );
  }

  if (user) {
    return <Navigate to="/" replace />;
  }

  const error = params.get('error');

  return (
    <div
      style={{
        minHeight: '100vh',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        padding: 20,
      }}
    >
      <div
        className="card"
        style={{
          maxWidth: 420,
          width: '100%',
          padding: 32,
          textAlign: 'center',
        }}
      >
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            gap: 10,
            fontSize: 24,
            fontWeight: 700,
            letterSpacing: '-0.01em',
          }}
        >
          Play DR Agents
        </div>

        <p
          className="muted"
          style={{ marginTop: 12, marginBottom: 28, fontSize: 14.5, lineHeight: 1.55 }}
        >
          Your team&apos;s shared brain of custom AI agents — every agent and
          conversation, visible to everyone.
        </p>

        {error && (
          <div className="error-banner" style={{ textAlign: 'left' }}>
            {error}
          </div>
        )}

        <button
          type="button"
          className="btn btn-primary btn-block"
          onClick={() => login()}
        >
          Continue with Google
        </button>

        <p className="hint" style={{ marginTop: 14, marginBottom: 0 }}>
          Access is limited to the Monks Google Workspace.
        </p>
      </div>
    </div>
  );
}
