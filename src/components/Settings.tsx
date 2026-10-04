import { useEffect, useRef, useState } from 'react';
import { Download, Upload, History, UserPlus, Trash2 } from 'lucide-react';
import { type MuseumDocument, type Frame } from '../core/model';
import { api, demo, exportDocument, versions } from '../lib/storage';
import { readMuseumImport } from '../core/documentImport';
import { Modal } from './common';
export default function Settings({
  doc,
  change,
  onRollback,
  onImport,
}: {
  doc: MuseumDocument;
  change: (fn: (d: MuseumDocument) => MuseumDocument) => void;
  onRollback: (id: string) => Promise<void>;
  onImport: (document: MuseumDocument) => Promise<void>;
}) {
  const [history, setHistory] = useState<Awaited<ReturnType<typeof versions>>>([]),
    [members, setMembers] = useState<{ user_id: string; email: string; role: string }[]>([]),
    [email, setEmail] = useState(''),
    [error, setError] = useState(''),
    [usage, setUsage] = useState<number | null>(null),
    [moreHistory, setMoreHistory] = useState(false),
    [loadingHistory, setLoadingHistory] = useState(false);
  const importInput = useRef<HTMLInputElement>(null);
  const [candidate, setCandidate] = useState<MuseumDocument | null>(null);
  const [importing, setImporting] = useState(false);
  const [importError, setImportError] = useState('');
  const [importMessage, setImportMessage] = useState('');
  useEffect(() => {
    versions()
      .then((rows) => {
        setHistory(rows);
        setMoreHistory(!demo && rows.length === 20);
      })
      .catch((e) => setError(e.message));
    if (!demo) {
      api('/members')
        .then(setMembers)
        .catch((e) => setError(e.message));
      void (async () => {
        let total = 0,
          next: { bucket: number; cursor?: string } | null = { bucket: 0 };
        while (next) {
          const page: { bytes: number; next: { bucket: number; cursor?: string } | null } =
            await api(
              '/usage?' +
                new URLSearchParams({
                  bucket: String(next.bucket),
                  ...(next.cursor ? { cursor: next.cursor } : {}),
                }),
            );
          total += page.bytes;
          next = page.next;
        }
        setUsage(total);
      })().catch(() => {});
    }
  }, []);
  const patch = (p: Partial<MuseumDocument>) => change((d) => ({ ...d, ...p }));
  return (
    <section className="settings">
      <div className="section-heading">
        <div>
          <span className="eyebrow">CONFIGURATION</span>
          <h2>Identity & administration</h2>
        </div>
      </div>
      <div className="settings-grid">
        <div>
          <h3>Museum identity</h3>
          <label>
            Museum name
            <input value={doc.name} onChange={(e) => patch({ name: e.target.value })} />
          </label>
          <label>
            Introduction
            <textarea
              rows={3}
              value={doc.subtitle}
              onChange={(e) => patch({ subtitle: e.target.value })}
            />
          </label>
          <label>
            Content language
            <input
              value={doc.language}
              onChange={(e) => patch({ language: e.target.value })}
              placeholder="en, es, fr…"
            />
          </label>
          <label className="toggle-label">
            <input
              type="checkbox"
              checked={doc.audioguide}
              onChange={(e) => patch({ audioguide: e.target.checked })}
            />
            <span>
              Offer an audioguide<small>Visitors decide whether to enable device narration.</small>
            </span>
          </label>
          <label>
            Default frame
            <select
              value={doc.defaultFrame.preset}
              onChange={(e) =>
                patch({
                  defaultFrame: { ...doc.defaultFrame, preset: e.target.value as Frame['preset'] },
                })
              }
            >
              {['none', 'black', 'white', 'wood', 'gold'].map((f) => (
                <option key={f}>{f}</option>
              ))}
            </select>
          </label>
          <label>
            Default frame width (cm)
            <input
              type="number"
              min="1"
              max="20"
              value={Math.round(doc.defaultFrame.width * 100)}
              onChange={(e) =>
                patch({
                  defaultFrame: {
                    ...doc.defaultFrame,
                    width: Math.max(1, Math.min(20, Number(e.target.value))) / 100,
                  },
                })
              }
            />
          </label>
          <label>
            Default mat (cm)
            <input
              type="number"
              min="0"
              max="25"
              value={Math.round(doc.defaultFrame.mat * 100)}
              onChange={(e) =>
                patch({
                  defaultFrame: {
                    ...doc.defaultFrame,
                    mat: Math.max(0, Math.min(25, Number(e.target.value))) / 100,
                  },
                })
              }
            />
          </label>
        </div>
        <div>
          <h3>Storage & backups</h3>
          <p className="muted">
            {usage !== null
              ? `${(usage / 1024 / 1024).toFixed(1)} MB stored, including retained publications.`
              : 'Local image files are stored in this browser. Cloud usage appears after configuration.'}
          </p>
          <div className="button-row">
            <button className="secondary" onClick={() => exportDocument(doc)}>
              <Download size={15} /> Export museum document
            </button>
            <button
              className="secondary"
              disabled={importing}
              onClick={() => importInput.current?.click()}
            >
              <Upload size={15} /> Import museum document
            </button>
          </div>
          <input
            ref={importInput}
            type="file"
            accept=".json,application/json"
            aria-label="Museum document file"
            hidden
            onChange={async (event) => {
              const file = event.currentTarget.files?.[0];
              event.currentTarget.value = '';
              if (!file) return;
              setImportError('');
              setImportMessage('');
              setImporting(true);
              try {
                setCandidate(await readMuseumImport(file));
              } catch (e) {
                setImportError((e as Error).message);
              } finally {
                setImporting(false);
              }
            }}
          />
          <p className="tiny muted">
            Export saves the draft's layout, artwork details and settings. Import restores that
            draft; it does not publish it. Image files are separate: keep both R2 buckets and the
            Supabase database backed up. In the local demo, import into the same browser containing
            the images.
          </p>
          {importError && !candidate && (
            <p role="alert" className="error">
              {importError}
            </p>
          )}
          {importMessage && <p role="status">{importMessage}</p>}
          {candidate && (
            <Modal
              title="Import museum document"
              onClose={() => {
                if (!importing) setCandidate(null);
              }}
            >
              <p>
                Replace the working draft with <strong>{candidate.name}</strong>?
              </p>
              <p>
                {candidate.rooms.length} rooms · {candidate.assets.length} artworks ·{' '}
                {candidate.regions.filter((region) => region.assetId).length} placements
              </p>
              <p>
                The published exhibition stays unchanged. Images must already exist in this
                installation. After import, you can undo it in Museum builder during this editing
                session.
              </p>
              <button
                className="secondary"
                disabled={importing}
                onClick={() => exportDocument(doc)}
              >
                Download current draft
              </button>
              {importError && (
                <p role="alert" className="error">
                  {importError}
                </p>
              )}
              <div className="button-row">
                <button
                  className="secondary"
                  disabled={importing}
                  onClick={() => setCandidate(null)}
                >
                  Cancel
                </button>
                <button
                  className="primary"
                  disabled={importing}
                  onClick={async () => {
                    setImporting(true);
                    setImportError('');
                    try {
                      await onImport(candidate);
                      setCandidate(null);
                      setImportMessage(
                        'Museum document imported and saved. Review it before publishing.',
                      );
                    } catch (e) {
                      setImportError((e as Error).message);
                    } finally {
                      setImporting(false);
                    }
                  }}
                >
                  {importing ? 'Checking images and importing…' : 'Replace draft'}
                </button>
              </div>
            </Modal>
          )}
          <hr />
          <h3>Published versions</h3>
          {history.length ? (
            history.map((v) => (
              <div className="history-entry" key={v.id}>
                <History size={16} />
                <span>
                  {v.name}
                  <small>{v.createdAt || v.id.slice(0, 8)}</small>
                </span>
                <button
                  className="secondary"
                  onClick={async () => {
                    try {
                      await onRollback(v.id);
                    } catch (e) {
                      setError((e as Error).message);
                    }
                  }}
                >
                  Restore
                </button>
              </div>
            ))
          ) : (
            <p className="muted">Your first publication will appear here.</p>
          )}
          {moreHistory && (
            <button
              className="secondary"
              disabled={loadingHistory}
              onClick={async () => {
                setLoadingHistory(true);
                try {
                  const rows = await versions(history.length);
                  setHistory((previous) => [...previous, ...rows]);
                  setMoreHistory(rows.length === 20);
                } catch (e) {
                  setError((e as Error).message);
                } finally {
                  setLoadingHistory(false);
                }
              }}
            >
              {loadingHistory ? 'Loading…' : 'Older publications'}
            </button>
          )}
          <hr />
          <h3>Invited editors</h3>
          {demo ? (
            <p className="muted">
              The local demo has one browser-local editor. Connect Supabase to manage invited
              accounts.
            </p>
          ) : (
            <>
              <form
                className="button-row"
                onSubmit={async (e) => {
                  e.preventDefault();
                  try {
                    await api('/members', { method: 'POST', body: JSON.stringify({ email }) });
                    setEmail('');
                    setMembers(await api('/members'));
                  } catch (e) {
                    setError((e as Error).message);
                  }
                }}
              >
                <input
                  type="email"
                  required
                  placeholder="editor@example.com"
                  aria-label="Invite email"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                />
                <button className="secondary" aria-label="Invite editor">
                  <UserPlus size={16} />
                </button>
              </form>
              {members.map((m) => (
                <div className="history-entry" key={m.user_id}>
                  <span>
                    {m.email}
                    <small>{m.role}</small>
                  </span>
                  {m.role !== 'owner' && (
                    <button
                      className="icon-button danger"
                      aria-label={`Revoke ${m.email}`}
                      onClick={async () => {
                        try {
                          await api(`/members/${m.user_id}`, { method: 'DELETE' });
                          setMembers(await api('/members'));
                        } catch (e) {
                          setError((e as Error).message);
                        }
                      }}
                    >
                      <Trash2 size={15} />
                    </button>
                  )}
                </div>
              ))}
            </>
          )}
          {error && (
            <p role="alert" className="error">
              {error}
            </p>
          )}
        </div>
      </div>
    </section>
  );
}
