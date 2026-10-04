import { lazy, Suspense, useEffect, useRef, useState } from 'react';
import {
  ArrowLeft,
  ArrowRight,
  BookOpen,
  Download,
  Headphones,
  Landmark,
  List,
  Map,
  MousePointer2,
  Pause,
  Volume2,
  Footprints,
  X,
  Settings2,
} from 'lucide-react';
import { type MuseumDocument } from '../core/model';
import { type SceneAction } from '../scene/MuseumScene';
import { assetUrl, demo, getPublished } from '../lib/storage';
import { Image, Modal, BookPage } from './common';
const MuseumScene = lazy(() => import('../scene/MuseumScene'));
export default function Visitor({
  preview,
  onEdit,
}: {
  preview?: MuseumDocument;
  onEdit: () => void;
}) {
  const [doc, setDoc] = useState<MuseumDocument | null>(preview ?? null),
    [version, setVersion] = useState('preview'),
    [error, setError] = useState(''),
    [mode, setMode] = useState<'points' | 'walk'>('points'),
    [overlay, setOverlay] = useState<SceneAction | { kind: 'catalog' | 'map'; id: string } | null>(
      null,
    ),
    [roomId, setRoomId] = useState(preview?.entrance ?? ''),
    [destination, setDestination] = useState<string | null>(null),
    [traveling, setTraveling] = useState(false),
    [guide, setGuide] = useState(false),
    [speaking, setSpeaking] = useState(''),
    [page, setPage] = useState(0),
    [started, setStarted] = useState(Boolean(preview));
  const generation = useRef(0),
    speechAvailable = typeof window !== 'undefined' && 'speechSynthesis' in window;
  useEffect(() => {
    if (preview) {
      setDoc(preview);
      return;
    }
    let live = true;
    getPublished()
      .then((result) => {
        if (live) {
          setDoc(result.document);
          setVersion(result.id);
          setRoomId(result.document.entrance);
        }
      })
      .catch((e) => setError(e.message));
    return () => {
      live = false;
    };
  }, [preview]);
  useEffect(
    () => () => {
      generation.current++;
      if (speechAvailable) window.speechSynthesis.cancel();
    },
    [speechAvailable],
  );
  function stop() {
    generation.current++;
    if (speechAvailable) speechSynthesis.cancel();
    setSpeaking('');
  }
  function narrate(id: string) {
    if (!doc || !guide || !doc.audioguide || !speechAvailable) return;
    const asset = doc.assets.find((a) => a.id === id);
    if (!asset?.explanation) return;
    stop();
    const run = generation.current;
    setSpeaking(asset.title);
    const chunks = asset.explanation.match(/[^.!?]+[.!?]*/g) ?? [asset.explanation];
    let index = 0;
    const speak = () => {
      if (run !== generation.current) return;
      if (index >= chunks.length) {
        setSpeaking('');
        return;
      }
      const u = new SpeechSynthesisUtterance(chunks[index++]);
      u.lang = doc.language;
      const voice = speechSynthesis
        .getVoices()
        .find((v) => v.lang.toLowerCase().startsWith(doc.language.toLowerCase().split('-')[0]));
      if (voice) u.voice = voice;
      u.onend = speak;
      u.onerror = () => {
        if (run === generation.current) {
          setSpeaking('');
          setError('Narration could not play on this device. You can still read the explanation.');
        }
      };
      speechSynthesis.speak(u);
    };
    speak();
  }
  if (!doc)
    return (
      <main className="loading">
        <Landmark size={34} />
        <h1>{error ? 'The museum is not open yet.' : 'Opening the museum…'}</h1>
        <p>{error}</p>
        <button className="secondary" onClick={onEdit}>
          Curator entrance
        </button>
      </main>
    );
  const currentRoom = doc.rooms.find((r) => r.id === roomId),
    asset = overlay?.kind === 'art' ? doc.assets.find((a) => a.id === overlay.id) : undefined,
    book = overlay?.kind === 'book' ? doc.rooms.find((r) => r.id === overlay.id) : undefined,
    exhibited = doc.assets.filter((a) => doc.regions.some((r) => r.assetId === a.id)),
    downloadable = exhibited.filter((a) => a.downloadable),
    hasShop = doc.rooms.some((r) => r.kind === 'shop');
  function action(action: SceneAction) {
    setPage(0);
    setOverlay(action);
    if (action.kind === 'art' && action.narrate) narrate(action.id);
  }
  const nearbyRooms = doc.connections
    .filter((c) => c.kind !== 'closed' && (c.a === roomId || c.b === roomId))
    .map((c) => ({
      connection: c,
      room: doc.rooms.find((r) => r.id === (c.a === roomId ? c.b : c.a))!,
    }))
    .filter((item) => item.room);
  async function download(id: string) {
    try {
      const a = doc!.assets.find((a) => a.id === id)!;
      let url;
      if (demo || preview) url = await assetUrl(a, 'original');
      else {
        const response = await fetch(`/api/download/${encodeURIComponent(version)}/${id}`);
        if (!response.ok) throw Error('This original is not available for download.');
        const blob = await response.blob();
        url = URL.createObjectURL(blob);
      }
      const link = document.createElement('a');
      link.href = url;
      link.download = a.title + '.' + (a.source.endsWith('.svg') ? 'svg' : a.mime.split('/')[1]);
      link.click();
      if (url.startsWith('blob:') && !demo && !preview)
        setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch (e) {
      setError((e as Error).message);
    }
  }
  return (
    <div className={`visitor ${preview ? 'embedded' : ''}`}>
      <Suspense fallback={<div className="loading">Preparing the gallery…</div>}>
        <MuseumScene
          doc={doc}
          mode={mode}
          paused={Boolean(overlay) || !started}
          destination={destination}
          onAction={action}
          onRoom={setRoomId}
          onError={setError}
          onTravel={setTraveling}
        />
      </Suspense>
      <header className="visitor-header">
        <button className="visitor-brand" onClick={() => setStarted(false)}>
          <Landmark size={23} />
          <span>
            {doc.name}
            <small>A MUSEUM BY E-XHIBIT</small>
          </span>
        </button>
        <div className="visitor-actions">
          <button aria-label="Collection" onClick={() => setOverlay({ kind: 'catalog', id: '' })}>
            <List size={17} />
            <span>Collection</span>
          </button>
          {doc.audioguide && (
            <button
              aria-label={`Audioguide ${guide ? 'on' : 'off'}`}
              aria-pressed={guide}
              disabled={!speechAvailable}
              title={speechAvailable ? 'Toggle audioguide' : 'Device narration is unavailable'}
              className={guide ? 'on' : ''}
              onClick={() => {
                if (guide) stop();
                setGuide(!guide);
              }}
            >
              <Headphones size={17} />
              <span>Audioguide {guide ? 'on' : 'off'}</span>
            </button>
          )}
          <button aria-label={preview ? 'Back to editor' : 'Curator'} onClick={onEdit}>
            <Settings2 size={16} />
            <span>{preview ? 'Back to editor' : 'Curator'}</span>
          </button>
        </div>
      </header>
      {!started && (
        <div className="welcome-overlay">
          <div>
            <span className="eyebrow">ONLINE EXHIBITION</span>
            <h1>{doc.name}</h1>
            <p>{doc.subtitle}</p>
            <button className="primary" onClick={() => setStarted(true)}>
              Enter exhibition <ArrowRight size={18} />
            </button>
            <button
              className="text-button"
              onClick={() => {
                setStarted(true);
                setOverlay({ kind: 'catalog', id: '' });
              }}
            >
              Browse the accessible collection
            </button>
            <span className="welcome-caption">E-XHIBIT / VIRTUAL MUSEUM</span>
          </div>
          {exhibited[0] && (
            <figure className="welcome-art">
              <Image asset={exhibited[0]} size="2048" />
              <figcaption>
                01 — {exhibited[0].title}
                <br />
                {exhibited[0].attribution}
              </figcaption>
            </figure>
          )}
        </div>
      )}
      {error && (
        <div className="visitor-error" role="alert">
          {error}
          <button aria-label="Dismiss message" onClick={() => setError('')}>
            <X size={15} />
          </button>
          <button onClick={() => setOverlay({ kind: 'catalog', id: '' })}>Browse collection</button>
        </div>
      )}
      <div className="visitor-bottom">
        <div className="location-pill">
          <span className="eyebrow">YOU ARE HERE</span>
          <strong>{currentRoom?.name ?? 'Between rooms'}</strong>
          <small>Floor {(currentRoom?.floor ?? 0) + 1}</small>
        </div>
        <div className="visitor-controls">
          <button disabled={traveling} onClick={() => setOverlay({ kind: 'map', id: '' })}>
            <Map size={17} /> Rooms
          </button>
          <span />
          <button className={mode === 'points' ? 'active' : ''} onClick={() => setMode('points')}>
            <MousePointer2 size={17} /> Point & explore
          </button>
          <button className={mode === 'walk' ? 'active' : ''} onClick={() => setMode('walk')}>
            <Footprints size={17} /> Walk
          </button>
        </div>
        <div className="visitor-tip">
          {mode === 'walk'
            ? 'W A S D to move · Mouse to look · Esc to release'
            : 'Drag to look · Select a floor circle to move here'}
        </div>
      </div>
      {started && !overlay && mode === 'points' && (
        <nav className="nearby-destinations" aria-label="Nearby destinations">
          <span className="eyebrow" role="status">
            {traveling ? 'MOVING TO YOUR DESTINATION…' : 'CONTINUE TO'}
          </span>
          {nearbyRooms.map(({ room }) => (
            <button
              key={room.id}
              disabled={traveling}
              onClick={() => setDestination(`${room.id}|${Date.now()}`)}
            >
              <span aria-hidden="true">
                {room.floor > (currentRoom?.floor ?? 0)
                  ? '↗'
                  : room.floor < (currentRoom?.floor ?? 0)
                    ? '↘'
                    : '→'}
              </span>
              {room.floor > (currentRoom?.floor ?? 0)
                ? 'Upstairs · '
                : room.floor < (currentRoom?.floor ?? 0)
                  ? 'Downstairs · '
                  : ''}
              {room.name}
            </button>
          ))}
        </nav>
      )}
      {speaking && (
        <div className="now-playing" role="status">
          <Volume2 size={17} />
          <span>
            Now playing <strong>{speaking}</strong>
          </span>
          <button aria-label="Stop narration" onClick={stop}>
            <Pause size={17} />
          </button>
        </div>
      )}
      {overlay?.kind === 'catalog' && (
        <Modal title="The collection" wide onClose={() => setOverlay(null)}>
          <p>{doc.subtitle}</p>
          <div className="catalog-grid">
            {exhibited.map((a) => (
              <button key={a.id} onClick={() => action({ kind: 'art', id: a.id })}>
                <Image asset={a} />
                <strong>{a.title}</strong>
                <span>{a.attribution}</span>
              </button>
            ))}
          </div>
        </Modal>
      )}
      {asset && (
        <Modal title={asset.title} wide onClose={() => setOverlay(null)}>
          <div className="asset-details">
            <div className="asset-detail-image">
              <Image asset={asset} size="2048" />
            </div>
            <div>
              <span className="eyebrow">FROM THE COLLECTION</span>
              <h2 className="serif">{asset.title}</h2>
              <p className="art-explanation">
                {asset.explanation || 'Take a moment to look a little closer.'}
              </p>
              <p className="muted tiny">{asset.attribution}</p>
              {doc.audioguide && guide && asset.explanation && (
                <button className="secondary" onClick={() => narrate(asset.id)}>
                  <Volume2 size={16} /> Listen to the explanation
                </button>
              )}
            </div>
          </div>
        </Modal>
      )}
      {book && (
        <Modal title={book.name} onClose={() => setOverlay(null)}>
          <div className="visitor-book">
            <BookPage text={book.pages[page] ?? ''} />
            <div className="book-navigation">
              <button
                aria-label="Previous page"
                disabled={page === 0}
                onClick={() => setPage((p) => p - 1)}
              >
                <ArrowLeft size={18} />
              </button>
              <span>
                Page {page + 1} of {book.pages.length}
              </span>
              <button
                aria-label="Next page"
                disabled={page === book.pages.length - 1}
                onClick={() => setPage((p) => p + 1)}
              >
                <ArrowRight size={18} />
              </button>
            </div>
          </div>
        </Modal>
      )}
      {overlay?.kind === 'shop' && hasShop && (
        <Modal title="Download collection" wide onClose={() => setOverlay(null)}>
          <p>
            Download an original from the collection. Please keep the artist’s attribution with it.
          </p>
          {downloadable.length ? (
            <div className="download-list">
              {downloadable.map((a) => (
                <div key={a.id}>
                  <Image asset={a} />
                  <span>
                    <b>{a.title}</b>
                    <small>{a.attribution}</small>
                  </span>
                  <button className="secondary" onClick={() => void download(a.id)}>
                    <Download size={16} /> Download
                  </button>
                </div>
              ))}
            </div>
          ) : (
            <p className="empty-state">The curator has not enabled any downloads yet.</p>
          )}
        </Modal>
      )}
      {overlay?.kind === 'map' && (
        <Modal title="Find your next room." onClose={() => setOverlay(null)}>
          <div className="room-directory">
            {doc.rooms.map((r) => (
              <div key={r.id}>
                <button
                  onClick={() => {
                    setDestination(r.id + '|' + Date.now());
                    setOverlay(null);
                    setStarted(true);
                  }}
                >
                  <span>
                    {r.kind === 'information' ? <BookOpen size={18} /> : <Landmark size={18} />}
                    <b>{r.name}</b>
                    <small>Floor {r.floor + 1}</small>
                  </span>
                  <ArrowRight size={17} />
                </button>
                {r.kind !== 'gallery' && (
                  <button
                    className="text-button"
                    onClick={() => {
                      setPage(0);
                      setOverlay({ kind: r.kind === 'information' ? 'book' : 'shop', id: r.id });
                    }}
                  >
                    {r.kind === 'information' ? 'Read information book' : 'Open download kiosk'}{' '}
                    <ArrowRight size={14} />
                  </button>
                )}
              </div>
            ))}
          </div>
        </Modal>
      )}
    </div>
  );
}
