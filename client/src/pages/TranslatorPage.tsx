import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { api, ApiError } from '../api/client';
import { useAuth } from '../auth/AuthContext';
import type { GlossaryEntry, TranslateConfig, TranslateRow } from '../types';

type OutputFormat = 'table' | 'bulleted' | 'csv' | 'json';

const FORMAT_META: Record<OutputFormat, { label: string; ext: string; mime: string }> = {
  table: { label: 'Table (TSV)', ext: 'tsv', mime: 'text/tab-separated-values' },
  bulleted: { label: 'Bulleted', ext: 'txt', mime: 'text/plain' },
  csv: { label: 'CSV', ext: 'csv', mime: 'text/csv' },
  json: { label: 'JSON', ext: 'json', mime: 'application/json' },
};

function csvField(s: string): string {
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function buildExport(
  format: OutputFormat,
  rows: TranslateRow[],
  langs: string[],
  chosen: (rowIdx: number, lang: string) => string,
  nameOf: (code: string) => string,
): string {
  if (rows.length === 0) return '';
  if (format === 'table' || format === 'csv') {
    const sep = format === 'table' ? '\t' : ',';
    const enc = format === 'csv' ? csvField : (s: string) => s;
    const header = ['Source', ...langs].map(enc).join(sep);
    const lines = rows.map((r, ri) => [r.source, ...langs.map((l) => chosen(ri, l))].map(enc).join(sep));
    return [header, ...lines].join('\n');
  }
  if (format === 'bulleted') {
    return langs
      .map((l) => `## ${nameOf(l)} (${l})\n` + rows.map((r, ri) => `- ${r.source} → ${chosen(ri, l)}`).join('\n'))
      .join('\n\n');
  }
  // json — i18n style: { "<lang>": { "<source>": "<translation>" } }
  const obj: Record<string, Record<string, string>> = {};
  for (const l of langs) {
    obj[l] = {};
    rows.forEach((r, ri) => {
      obj[l][r.source] = chosen(ri, l);
    });
  }
  return JSON.stringify(obj, null, 2);
}

/** Small info icon that reveals a tooltip on hover/focus. */
function InfoTip({ text }: { text: string }) {
  return (
    <span className="info-tip" tabIndex={0} aria-label={text}>
      <span className="info-icon" aria-hidden>
        i
      </span>
      <span className="info-bubble" role="tooltip">
        {text}
      </span>
    </span>
  );
}

export default function TranslatorPage() {
  const { user } = useAuth();
  const [config, setConfig] = useState<TranslateConfig | null>(null);

  // input
  const [input, setInput] = useState('');
  const [perLine, setPerLine] = useState(true);
  const [selected, setSelected] = useState<Set<string>>(() => new Set(['es-ES', 'fr-FR', 'pt-BR']));
  const [maxChars, setMaxChars] = useState('');
  const [contentType, setContentType] = useState('');

  // results
  const [results, setResults] = useState<TranslateRow[] | null>(null);
  const [useVariant, setUseVariant] = useState<Set<string>>(() => new Set());
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // export
  const [format, setFormat] = useState<OutputFormat>('table');
  const [copied, setCopied] = useState(false);

  // dictionary
  const [dict, setDict] = useState<{ lang: string; term: string; value: string; note: string } | null>(null);
  const [dictBusy, setDictBusy] = useState(false);
  const [showGlossary, setShowGlossary] = useState(false);
  const [glossary, setGlossary] = useState<GlossaryEntry[] | null>(null);

  useEffect(() => {
    api.tools
      .translateConfig()
      .then((c) => {
        setConfig(c);
        setContentType(c.defaultContentType);
      })
      .catch(() => undefined);
  }, []);

  const langs = useMemo(() => Array.from(selected), [selected]);
  const nameOf = useMemo(() => {
    const map = new Map((config?.languages ?? []).map((l) => [l.code, l.name]));
    return (code: string) => map.get(code) ?? code;
  }, [config]);

  const maxNum = maxChars.trim() ? Number(maxChars) : undefined;
  const limit = Number.isFinite(maxNum) && (maxNum as number) > 0 ? (maxNum as number) : undefined;

  const cellKey = (ri: number, lang: string) => `${ri}:${lang}`;

  const chosen = (ri: number, lang: string): string => {
    const cell = results?.[ri]?.translations.find((c) => c.lang === lang);
    if (!cell) return '';
    return useVariant.has(cellKey(ri, lang)) && cell.variant ? cell.variant : cell.api;
  };

  function toggleLang(code: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(code)) next.delete(code);
      else next.add(code);
      return next;
    });
  }

  async function handleTranslate() {
    const texts = perLine
      ? input.split('\n').map((s) => s.trim()).filter(Boolean)
      : [input.trim()].filter(Boolean);
    if (texts.length === 0) {
      setError('Enter some text to translate.');
      return;
    }
    if (selected.size === 0) {
      setError('Pick at least one target language.');
      return;
    }
    setLoading(true);
    setError(null);
    try {
      const rows = await api.tools.translate({
        texts,
        targetLangs: langs,
        maxChars: limit,
        contentType: contentType || undefined,
      });
      setResults(rows);
      // Auto-prefer the fit-variant where the API result is over the limit.
      const auto = new Set<string>();
      rows.forEach((r, ri) =>
        r.translations.forEach((c) => {
          if (!c.fits && c.variant) auto.add(cellKey(ri, c.lang));
        }),
      );
      setUseVariant(auto);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Translation failed.');
    } finally {
      setLoading(false);
    }
  }

  const exportText = useMemo(
    () => (results ? buildExport(format, results, langs, chosen, nameOf) : ''),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [format, results, langs, useVariant, nameOf],
  );

  async function copyExport() {
    try {
      await navigator.clipboard.writeText(exportText);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1500);
    } catch {
      setError('Could not copy to clipboard.');
    }
  }

  function downloadExport() {
    const meta = FORMAT_META[format];
    const blob = new Blob([exportText], { type: meta.mime });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `translations.${meta.ext}`;
    a.click();
    URL.revokeObjectURL(url);
  }

  async function saveDict() {
    if (!dict || !dict.term.trim() || !dict.value.trim()) return;
    setDictBusy(true);
    try {
      await api.tools.glossary.save({
        sourceTerm: dict.term.trim(),
        targetLang: dict.lang,
        preferredTranslation: dict.value.trim(),
        note: dict.note.trim(),
      });
      setDict(null);
      setShowGlossary(true);
      await loadGlossary();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not save to dictionary.');
    } finally {
      setDictBusy(false);
    }
  }

  async function loadGlossary() {
    setGlossary(await api.tools.glossary.list().catch(() => []));
  }

  function toggleGlossary() {
    const next = !showGlossary;
    setShowGlossary(next);
    if (next && glossary === null) void loadGlossary();
  }

  /** Open the dictionary modal to add an entry from scratch (no cell context). */
  function openDictManual() {
    const lang = Array.from(selected)[0] ?? config?.languages[0]?.code ?? 'es-ES';
    setDict({ lang, term: '', value: '', note: '' });
  }

  async function removeGlossary(id: string) {
    if (!window.confirm('Remove this dictionary entry?')) return;
    try {
      await api.tools.glossary.remove(id);
      setGlossary((prev) => (prev ? prev.filter((g) => g.id !== id) : prev));
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not remove entry.');
    }
  }

  return (
    <div className="page">
      <div className="page-header">
        <div>
          <h1 className="page-title">
            <span style={{ marginRight: 8 }} aria-hidden>
              🌐
            </span>
            Localizer
          </h1>
          <p className="page-subtitle">
            Translate one or many lines into multiple languages at once. Set a character limit to get a
            Gemini-shortened variant, and teach the shared dictionary so the right terms stick.
            {config && config.provider === 'mock' && (
              <span className="badge" style={{ marginLeft: 8 }}>
                mock provider
              </span>
            )}
          </p>
        </div>
        <Link to="/" className="btn btn-ghost btn-sm">
          ← Back
        </Link>
      </div>

      {error && <div className="error-banner">{error}</div>}

      {/* ---------- input ---------- */}
      <div className="card" style={{ padding: 20, marginBottom: 18 }}>
        <div className="field">
          <label className="label" htmlFor="tx-input">
            Text to translate
          </label>
          <textarea
            id="tx-input"
            className="textarea"
            rows={5}
            placeholder={'One item per line, e.g.\nBuy a car now\nWelcome, {name}!'}
            value={input}
            onChange={(e) => setInput(e.target.value)}
          />
          <label className="checkbox-label" style={{ marginTop: 8 }}>
            <input type="checkbox" checked={perLine} onChange={(e) => setPerLine(e.target.checked)} />
            Treat each line as a separate item
          </label>
        </div>

        <div className="field">
          <span className="label">Target languages</span>
          <div className="row" style={{ flexWrap: 'wrap', gap: 8 }}>
            {(config?.languages ?? []).map((l) => (
              <button
                key={l.code}
                type="button"
                className={`chip ${selected.has(l.code) ? 'active' : ''}`}
                onClick={() => toggleLang(l.code)}
                title={l.code}
              >
                {l.name}
              </button>
            ))}
          </div>
        </div>

        <div className="row" style={{ gap: 20, flexWrap: 'wrap', alignItems: 'flex-end' }}>
          <div className="field" style={{ marginBottom: 0 }}>
            <span style={{ display: 'flex', alignItems: 'center', gap: 5, marginBottom: 6 }}>
              <label className="label" htmlFor="tx-max" style={{ margin: 0 }}>
                Max characters (optional)
              </label>
              <InfoTip text="Optional. If a translation goes over this length, the agent adds a Gemini-shortened variant that fits — you keep both and choose." />
            </span>
            <input
              id="tx-max"
              className="input"
              type="number"
              min={1}
              placeholder="e.g. 20"
              value={maxChars}
              onChange={(e) => setMaxChars(e.target.value)}
              style={{ width: 160 }}
            />
          </div>
          <div className="field" style={{ marginBottom: 0 }}>
            <span style={{ display: 'flex', alignItems: 'center', gap: 5, marginBottom: 6 }}>
              <label className="label" htmlFor="tx-ct" style={{ margin: 0 }}>
                Content type
              </label>
              <InfoTip text="Tells the translator what kind of content this is (UI, marketing, legal, …) so it adapts tone, formality, and terminology to match." />
            </span>
            <select
              id="tx-ct"
              className="select"
              value={contentType}
              onChange={(e) => setContentType(e.target.value)}
              style={{ width: 220 }}
            >
              {(config?.contentTypes ?? []).map((c) => (
                <option key={c} value={c}>
                  {c.replace('CONTENT_TYPE_', '')}
                </option>
              ))}
            </select>
          </div>
          <button
            type="button"
            className="btn btn-primary"
            onClick={() => void handleTranslate()}
            disabled={loading}
            style={{ marginLeft: 'auto' }}
          >
            {loading ? <span className="spinner" /> : 'Translate'}
          </button>
        </div>
      </div>

      {/* ---------- results ---------- */}
      {results && results.length > 0 && (
        <div className="card" style={{ padding: 20, marginBottom: 18, overflowX: 'auto' }}>
          <table className="tx-table">
            <thead>
              <tr>
                <th style={{ minWidth: 180 }}>Source</th>
                {langs.map((l) => (
                  <th key={l} style={{ minWidth: 200 }}>
                    {nameOf(l)} <span className="tx-len">{l}</span>
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {results.map((row, ri) => (
                <tr key={ri}>
                  <td style={{ fontWeight: 550 }}>{row.source}</td>
                  {langs.map((l) => {
                    const cell = row.translations.find((c) => c.lang === l);
                    if (!cell) return <td key={l} className="muted">—</td>;
                    const showingVariant = useVariant.has(cellKey(ri, l)) && !!cell.variant;
                    const text = showingVariant ? cell.variant! : cell.api;
                    const len = showingVariant ? cell.variantLen ?? 0 : cell.apiLen;
                    const over = limit != null && len > limit;
                    return (
                      <td key={l}>
                        <div style={{ whiteSpace: 'pre-wrap' }}>{text}</div>
                        <div className="row" style={{ gap: 8, marginTop: 6, flexWrap: 'wrap' }}>
                          <span className={`tx-len ${over ? 'tx-over' : ''}`}>
                            {len}
                            {limit != null ? `/${limit}` : ''} chars
                          </span>
                          {cell.variant && (
                            <button
                              type="button"
                              className="btn btn-ghost btn-sm"
                              style={{ padding: '1px 8px', fontSize: 12 }}
                              onClick={() =>
                                setUseVariant((prev) => {
                                  const next = new Set(prev);
                                  const k = cellKey(ri, l);
                                  next.has(k) ? next.delete(k) : next.add(k);
                                  return next;
                                })
                              }
                              title="Switch between the API translation and the Gemini variant"
                            >
                              {showingVariant ? 'API' : 'Variant'}
                            </button>
                          )}
                          {cell.glossaryApplied.length > 0 && (
                            <span className="badge badge-accent" title={cell.glossaryApplied.join(', ')}>
                              📖 {cell.glossaryApplied.length}
                            </span>
                          )}
                          <button
                            type="button"
                            className="btn btn-ghost btn-sm"
                            style={{ padding: '1px 8px', fontSize: 12 }}
                            onClick={() => setDict({ lang: l, term: row.source, value: text, note: '' })}
                            title="Save a preferred translation to the shared dictionary"
                          >
                            📌 dict
                          </button>
                        </div>
                      </td>
                    );
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {/* ---------- export ---------- */}
      {results && results.length > 0 && (
        <div className="card" style={{ padding: 20, marginBottom: 18 }}>
          <div className="row" style={{ justifyContent: 'space-between', flexWrap: 'wrap', gap: 12 }}>
            <div className="seg">
              {(Object.keys(FORMAT_META) as OutputFormat[]).map((f) => (
                <button key={f} className={format === f ? 'active' : ''} onClick={() => setFormat(f)}>
                  {FORMAT_META[f].label}
                </button>
              ))}
            </div>
            <div className="row" style={{ gap: 8 }}>
              <button type="button" className="btn btn-sm" onClick={() => void copyExport()}>
                {copied ? 'Copied ✓' : 'Copy'}
              </button>
              <button type="button" className="btn btn-sm" onClick={downloadExport}>
                Download .{FORMAT_META[format].ext}
              </button>
            </div>
          </div>
          <textarea
            className="textarea"
            readOnly
            value={exportText}
            rows={Math.min(14, Math.max(5, results.length * langs.length + 2))}
            style={{ marginTop: 12, fontFamily: 'var(--mono)', fontSize: 12.5 }}
          />
        </div>
      )}

      {/* ---------- glossary panel ---------- */}
      <div className="card" style={{ padding: 20 }}>
        <button type="button" className="btn btn-ghost btn-sm" onClick={toggleGlossary}>
          {showGlossary ? '▾' : '▸'} Shared dictionary{glossary ? ` (${glossary.length})` : ''}
        </button>
        <button
          type="button"
          className="btn btn-sm"
          style={{ marginLeft: 8 }}
          onClick={() => openDictManual()}
        >
          + Add entry
        </button>
        {showGlossary && (
          <div style={{ marginTop: 12 }}>
            {glossary === null ? (
              <span className="spinner" />
            ) : glossary.length === 0 ? (
              <p className="muted" style={{ fontSize: 13 }}>
                No entries yet. Use “📌 dict” on a translation to teach a preferred term.
              </p>
            ) : (
              <table className="tx-table">
                <thead>
                  <tr>
                    <th>Term</th>
                    <th>Lang</th>
                    <th>Preferred</th>
                    <th>Note</th>
                    <th></th>
                  </tr>
                </thead>
                <tbody>
                  {glossary.map((g) => (
                    <tr key={g.id}>
                      <td>{g.sourceTerm}</td>
                      <td>{g.targetLang}</td>
                      <td>{g.preferredTranslation}</td>
                      <td className="muted">{g.note}</td>
                      <td>
                        {(user?.role === 'ADMIN' || g.createdBy?.id === user?.id) && (
                          <button
                            type="button"
                            className="btn btn-ghost btn-sm"
                            style={{ padding: '1px 8px', fontSize: 12 }}
                            onClick={() => void removeGlossary(g.id)}
                          >
                            ✕
                          </button>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        )}
      </div>

      {/* ---------- save-to-dictionary modal ---------- */}
      {dict && (
        <div className="modal-overlay" role="dialog" aria-modal="true" onClick={() => setDict(null)}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <h3>Teach the dictionary</h3>
            <p className="muted" style={{ marginTop: 4 }}>
              Future translations into the selected language will use your preferred term.
            </p>
            <div className="field" style={{ marginTop: 12 }}>
              <label className="label">Target language</label>
              <select
                className="select"
                value={dict.lang}
                onChange={(e) => setDict({ ...dict, lang: e.target.value })}
              >
                {(config?.languages ?? []).map((l) => (
                  <option key={l.code} value={l.code}>
                    {l.name} ({l.code})
                  </option>
                ))}
              </select>
            </div>
            <div className="field">
              <label className="label">Source term</label>
              <input
                className="input"
                value={dict.term}
                onChange={(e) => setDict({ ...dict, term: e.target.value })}
                placeholder="e.g. car"
              />
              <p className="hint">Tip: narrow it to the specific word (e.g. “car”), not the whole sentence.</p>
            </div>
            <div className="field">
              <label className="label">Preferred translation ({dict.lang})</label>
              <input
                className="input"
                value={dict.value}
                onChange={(e) => setDict({ ...dict, value: e.target.value })}
                placeholder="e.g. carro"
              />
            </div>
            <div className="field" style={{ marginBottom: 0 }}>
              <label className="label">Note (optional)</label>
              <input
                className="input"
                value={dict.note}
                onChange={(e) => setDict({ ...dict, note: e.target.value })}
                placeholder="e.g. client rejected 'auto'"
              />
            </div>
            <div className="modal-actions">
              <button type="button" className="btn btn-ghost" onClick={() => setDict(null)} disabled={dictBusy}>
                Cancel
              </button>
              <button
                type="button"
                className="btn btn-primary"
                onClick={() => void saveDict()}
                disabled={dictBusy || !dict.term.trim() || !dict.value.trim()}
              >
                {dictBusy ? <span className="spinner" /> : 'Save to dictionary'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
