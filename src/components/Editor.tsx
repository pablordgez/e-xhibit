import { lazy, Suspense, useMemo, useState } from 'react';
import {
  LayoutDashboard,
  Image as ImageIcon,
  BookOpen,
  Settings as SettingsIcon,
  ArrowUpRight,
  Undo2,
  Redo2,
  Check,
  Globe,
  HelpCircle,
  LogOut,
  ArrowRight,
  AlertTriangle,
  Grid2X2,
  Box,
  PanelTop,
  Download,
} from 'lucide-react';
import { useMuseum } from '../lib/useMuseum';
import { demo, exportDocument } from '../lib/storage';
import { compile } from '../core/layout';
import { validateRenderedBooks } from '../lib/bookValidation';
import FloorPlan from './FloorPlan';
import WallEditor from './WallEditor';
import Library from './Library';
import RoomContents from './RoomContents';
import Settings from './Settings';
import { Modal } from './common';
const Visitor = lazy(() => import('./Visitor'));
const nav = [
  { id: 'spaces', label: 'Museum builder', icon: LayoutDashboard },
  { id: 'collection', label: 'Art collection', icon: ImageIcon },
  { id: 'contents', label: 'Room experiences', icon: BookOpen },
  { id: 'settings', label: 'Museum settings', icon: SettingsIcon },
] as const;
export default function Editor({
  onVisit,
  onSignOut,
}: {
  onVisit: () => void;
  onSignOut: () => void;
}) {
  const museum = useMuseum(),
    { doc, change } = museum;
  const [section, setSection] = useState<string>('spaces'),
    [view, setView] = useState('plan'),
    [selected, setSelected] = useState('light'),
    [floor, setFloor] = useState(0),
    [publishDialog, setPublishDialog] = useState(false),
    [help, setHelp] = useState(false),
    [publishing, setPublishing] = useState(false),
    [published, setPublished] = useState(false);
  const layout = useMemo(() => (doc ? compile(doc) : null), [doc]);
  if (!doc)
    return (
      <main className="loading">
        <p>{museum.error || 'Loading museum…'}</p>
        {museum.error && (
          <button className="secondary" onClick={onSignOut}>
            Sign out
          </button>
        )}
      </main>
    );
  const selectedId = doc.rooms.some((r) => r.id === selected) ? selected : doc.rooms[0].id;
  const title =
    section === 'spaces'
      ? 'Museum builder'
      : section === 'collection'
        ? 'The collection'
        : section === 'contents'
          ? 'Visitor resources'
          : 'Museum settings';
  async function publish() {
    setPublishing(true);
    try {
      const bookIssues = await validateRenderedBooks(doc!);
      if (bookIssues.length) throw Error(bookIssues.join(' '));
      await museum.publish();
      setPublished(true);
    } catch (e) {
      museum.setError((e as Error).message);
    } finally {
      setPublishing(false);
    }
  }
  return (
    <div className="studio">
      <aside className="sidebar">
        <a className="brand" href="/admin" onClick={(e) => e.preventDefault()}>
          <span>
            e<span className="brand-dash">—</span>xhibit<span className="brand-period">.</span>
          </span>
        </a>
        <div className="museum-switcher">
          <div>
            <small>CURRENT EXHIBITION</small>
            <strong>{doc.name}</strong>
          </div>
        </div>
        <span className="nav-caption">WORKSPACE</span>
        <nav>
          {nav.map((item, index) => (
            <button
              key={item.id}
              className={section === item.id ? 'active' : ''}
              onClick={() => setSection(item.id)}
            >
              <span className="nav-index" aria-hidden="true">
                {String(index + 1).padStart(2, '0')}
              </span>
              {item.label}
              {item.id === 'collection' && <span className="count">{doc.assets.length}</span>}
            </button>
          ))}
        </nav>
        <div className="sidebar-bottom">
          <div className="sidebar-note">
            <span className="eyebrow">EXHIBITION STATUS</span>
            <p>{museum.publication ? 'Published' : 'Draft'}</p>
            <span>
              {doc.regions.filter((r) => r.assetId).length} works on display
              <br />
              {doc.rooms.length} rooms · {new Set(doc.rooms.map((r) => r.floor)).size} floors
            </span>
          </div>
          <button onClick={() => setHelp(true)}>
            <HelpCircle size={17} /> Editor guide <ArrowUpRight size={14} />
          </button>
          <button onClick={onSignOut} disabled={demo}>
            <span className="avatar">C</span>
            <span>
              Curator<small>{demo ? 'Local demo studio' : 'Museum administrator'}</small>
            </span>
            <LogOut size={15} />
          </button>
        </div>
      </aside>
      <main className="main-studio">
        <header className="topbar">
          <span className="breadcrumb">
            STUDIO <span>/</span> {doc.name}
          </span>
          <div className="topbar-right">
            <span className="save-status">
              <i className={museum.error ? 'failed' : ''} />
              {museum.status}
            </span>
            <button className="secondary" onClick={onVisit}>
              Visit museum <ArrowUpRight size={14} />
            </button>
            <button
              className="primary publish-button"
              onClick={() => {
                setPublished(false);
                setPublishDialog(true);
              }}
            >
              Save and publish <ArrowUpRight size={16} />
            </button>
          </div>
        </header>
        <div className="page-heading">
          <div>
            <span className="eyebrow">
              {String(nav.findIndex((item) => item.id === section) + 1).padStart(2, '0')} /
              EXHIBITION DESIGN
            </span>
            <h1>{title}</h1>
            <p>
              {section === 'spaces'
                ? 'Arrange spaces. Place works. Open the doors.'
                : section === 'collection'
                  ? 'Images, descriptions, and permissions.'
                  : section === 'contents'
                    ? 'Information books and the museum shop.'
                    : 'Identity, access, and publication history.'}
            </p>
          </div>
          <span className="heading-index" aria-hidden="true">
            {String(nav.findIndex((item) => item.id === section) + 1).padStart(2, '0')}
          </span>
        </div>
        {museum.error && (
          <div className="error-banner" role="alert">
            <AlertTriangle size={18} />
            <span>{museum.error}</span>
            <button onClick={() => exportDocument(doc)}>Export unsaved work</button>
            <button onClick={() => void museum.reload()}>Reload saved draft</button>
          </div>
        )}
        {demo && (
          <div className="demo-strip">
            LOCAL DEMO <span>Saved to this browser. Connect hosting to publish online.</span>
          </div>
        )}
        {section === 'spaces' ? (
          <>
            <div className="workspace-tabs">
              <div className="tab-buttons">
                {[
                  { id: 'plan', label: 'Floor plan', icon: Grid2X2 },
                  { id: 'walls', label: 'Wall layouts', icon: PanelTop },
                  { id: 'preview', label: '3D preview', icon: Box },
                ].map((tab) => (
                  <button
                    key={tab.id}
                    className={view === tab.id ? 'active' : ''}
                    onClick={() => setView(tab.id)}
                  >
                    <tab.icon size={16} />
                    {tab.label}
                  </button>
                ))}
              </div>
              <div className="history-buttons">
                <button aria-label="Undo" disabled={!museum.canUndo} onClick={museum.undo}>
                  <Undo2 size={16} />
                </button>
                <button aria-label="Redo" disabled={!museum.canRedo} onClick={museum.redo}>
                  <Redo2 size={16} />
                </button>
              </div>
            </div>
            <div className="workspace">
              {view === 'plan' ? (
                <FloorPlan
                  doc={doc}
                  change={change}
                  selected={selectedId}
                  select={setSelected}
                  floor={floor}
                  setFloor={setFloor}
                  editWall={() => setView('walls')}
                />
              ) : view === 'walls' ? (
                <WallEditor
                  doc={doc}
                  change={change}
                  roomId={selectedId}
                  selectRoom={setSelected}
                />
              ) : (
                <div className="preview-wrapper">
                  <Suspense fallback={<div className="loading">Opening the gallery…</div>}>
                    <Visitor preview={doc} onEdit={() => setView('plan')} />
                  </Suspense>
                </div>
              )}
            </div>
            <div className="workspace-summary">
              <span>
                <b>{doc.rooms.length}</b> rooms
              </span>
              <span>
                <b>{new Set(doc.rooms.map((r) => r.floor)).size}</b> floors
              </span>
              <span>
                <b>{doc.regions.filter((r) => r.assetId).length}</b> artworks on display
              </span>
              <span>
                <b>{doc.rooms.length * 36}</b> m² floor area
              </span>
              <button
                onClick={() => setPublishDialog(true)}
                className={layout?.issues.length ? 'validation-warning' : 'validation-good'}
              >
                {layout?.issues.length ? (
                  <>
                    <AlertTriangle size={14} />
                    {layout.issues.length} items to review
                  </>
                ) : (
                  <>
                    <Check size={14} /> Ready to publish
                  </>
                )}
              </button>
            </div>
          </>
        ) : section === 'collection' ? (
          <Library doc={doc} change={change} />
        ) : section === 'contents' ? (
          <RoomContents doc={doc} change={change} />
        ) : (
          <Settings doc={doc} change={change} onRollback={museum.rollback} />
        )}
        <footer className="studio-footer">
          <span>E-xhibit — Exhibition studio</span>
          <span>
            E-XHIBIT <i>·</i> BUILD / CURATE / PUBLISH
          </span>
        </footer>
      </main>
      {publishDialog && (
        <Modal
          title={published ? 'Your museum is open.' : 'Ready to open the doors?'}
          onClose={() => setPublishDialog(false)}
        >
          {published ? (
            <div className="publish-success">
              <Check size={38} />
              <p>
                {demo
                  ? 'Your local museum version is saved.'
                  : 'New visitors will now see this museum.'}{' '}
                Existing visits retain their previous version.
              </p>
              <button className="primary" onClick={onVisit}>
                Visit museum <ArrowRight size={16} />
              </button>
            </div>
          ) : (
            <>
              <p>
                Publishing creates a complete version of your museum. Your private draft remains
                editable.
              </p>
              {layout?.issues.length ? (
                <div className="validation-list">
                  {layout.issues.map((i, n) => (
                    <div key={n}>
                      <AlertTriangle size={16} />
                      <span>
                        {i.message}
                        <small>{i.target}</small>
                      </span>
                    </div>
                  ))}
                </div>
              ) : (
                <div className="notice">
                  <Check size={19} /> All rooms are connected and your exhibits are ready.
                </div>
              )}
              {museum.error && (
                <p role="alert" className="error">
                  {museum.error}
                </p>
              )}
              <div className="modal-actions">
                <button className="secondary" onClick={() => exportDocument(doc)}>
                  <Download size={15} /> Export backup
                </button>
                <button
                  className="primary"
                  disabled={Boolean(layout?.issues.length) || publishing}
                  onClick={() => void publish()}
                >
                  {publishing ? 'Publishing…' : 'Save and publish'} <Globe size={15} />
                </button>
              </div>
            </>
          )}
        </Modal>
      )}
      {help && (
        <Modal title="Editor guide" onClose={() => setHelp(false)}>
          <ol className="help-list">
            <li>
              <b>Build your floor plan.</b> Add rooms on empty grid cells. Adjacent rooms get a
              doorway. Select a room to merge connections or choose a special type.
            </li>
            <li>
              <b>Bring your collection.</b> Upload images in Art collection. Their proportions are
              always preserved.
            </li>
            <li>
              <b>Give each piece a place.</b> Open Wall layouts, add a grid, and split it into
              regions. Shift-click regions to merge them. Choose a frame for each work.
            </li>
            <li>
              <b>Explore before opening.</b> Use 3D preview, check any validation messages, then
              Save and publish.
            </li>
          </ol>
          <p>
            Stairs join adjacent grid cells on consecutive floors. Spiral stairs join matching cells
            directly above each other. Corridors join separated rooms on one floor.
          </p>
        </Modal>
      )}
    </div>
  );
}
