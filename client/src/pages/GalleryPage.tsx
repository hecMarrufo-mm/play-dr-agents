import { useEffect, useMemo, useState, type CSSProperties } from 'react';
import { Link } from 'react-router-dom';
import { api, ApiError } from '../api/client';
import { PINNED_TOOLS } from '../tools';
import type { AgentListItem } from '../types';

const cardStyle: CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: 10,
  padding: 18,
  color: 'inherit',
};
const titleRow: CSSProperties = {
  display: 'flex',
  alignItems: 'flex-start',
  justifyContent: 'space-between',
  gap: 8,
};
const clamp2: CSSProperties = {
  margin: 0,
  fontSize: 13.5,
  lineHeight: 1.5,
  display: '-webkit-box',
  WebkitLineClamp: 2,
  WebkitBoxOrient: 'vertical',
  overflow: 'hidden',
};

/** Gallery / home (route '/'): every agent + built-in tool, together in one grid. */
export default function GalleryPage() {
  const [agents, setAgents] = useState<AgentListItem[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState('');

  useEffect(() => {
    let active = true;
    setError(null);
    api.agents
      .list()
      .then((list) => {
        if (active) setAgents(list);
      })
      .catch((err) => {
        if (!active) return;
        setError(err instanceof ApiError ? err.message : 'Failed to load agents.');
        setAgents([]);
      });
    return () => {
      active = false;
    };
  }, []);

  const q = query.trim().toLowerCase();

  const tools = useMemo(
    () => PINNED_TOOLS.filter((t) => !q || `${t.title} ${t.description}`.toLowerCase().includes(q)),
    [q],
  );

  const filteredAgents = useMemo(() => {
    if (!agents) return [];
    if (!q) return agents;
    return agents.filter((a) =>
      [a.title, a.description, a.owner.name].some((field) => field.toLowerCase().includes(q)),
    );
  }, [agents, q]);

  const loading = agents === null;
  const noAgentsAtAll = !loading && agents !== null && agents.length === 0;
  const empty = !loading && tools.length === 0 && filteredAgents.length === 0;

  return (
    <div className="page">
      <div className="page-header">
        <div>
          <h1 className="page-title">Agents</h1>
          <p className="page-subtitle">
            Every agent and tool your team has built. Open one to read its shared history and keep
            the conversation going.
          </p>
        </div>
        <Link to="/agents/new" className="btn btn-primary">
          + New agent
        </Link>
      </div>

      {error && <div className="error-banner">{error}</div>}

      {loading ? (
        <div className="centered">
          <span className="spinner" />
        </div>
      ) : (
        <>
          <input
            type="search"
            className="input"
            placeholder="Search agents and tools…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            aria-label="Search agents and tools"
            style={{ marginBottom: 20 }}
          />

          {empty ? (
            <div className="empty-state">
              <h3 style={{ marginBottom: 8 }}>{noAgentsAtAll ? 'No agents yet' : 'No matches'}</h3>
              <p style={{ marginBottom: noAgentsAtAll ? 20 : 0 }}>
                {noAgentsAtAll
                  ? 'Build the first shared agent for your team. Everyone can read its history and pick up the conversation.'
                  : `Nothing matches “${query.trim()}”. Try a different name or description.`}
              </p>
              {noAgentsAtAll && (
                <Link to="/agents/new" className="btn btn-primary">
                  + New agent
                </Link>
              )}
            </div>
          ) : (
            <div className="grid">
              {tools.map((tool) => (
                <Link key={`tool-${tool.slug}`} to={tool.route} className="card" style={cardStyle}>
                  <div style={titleRow}>
                    <strong style={{ fontSize: 16, letterSpacing: '-0.01em', lineHeight: 1.3 }}>
                      <span aria-hidden style={{ marginRight: 6 }}>
                        {tool.emoji}
                      </span>
                      {tool.title}
                    </strong>
                    <span className="badge badge-accent">tool</span>
                  </div>
                  <p className="muted" style={clamp2}>
                    {tool.description}
                  </p>
                </Link>
              ))}

              {filteredAgents.map((agent) => (
                <Link key={agent.id} to={`/agents/${agent.id}`} className="card" style={cardStyle}>
                  <div style={titleRow}>
                    <strong style={{ fontSize: 16, letterSpacing: '-0.01em', lineHeight: 1.3 }}>
                      {agent.title}
                    </strong>
                    <span className="badge badge-accent">agent</span>
                  </div>
                  <p className="muted" style={clamp2}>
                    {agent.description || 'No description provided.'}
                  </p>
                  <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginTop: 'auto', paddingTop: 6 }}>
                    <span className="badge">{agent.messageCount} messages</span>
                    <span className="badge">{agent.fileCount} files</span>
                  </div>
                </Link>
              ))}
            </div>
          )}
        </>
      )}
    </div>
  );
}
