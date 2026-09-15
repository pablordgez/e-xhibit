import { useState } from 'react';
import { Plus, ArrowUp, ArrowDown, Trash2, BookOpen, ShoppingBag } from 'lucide-react';
import { type MuseumDocument } from '../core/model';
import { bookPageFits } from '../core/layout';
import { BookPage, Image } from './common';
export default function RoomContents({
  doc,
  change,
}: {
  doc: MuseumDocument;
  change: (fn: (d: MuseumDocument) => MuseumDocument) => void;
}) {
  const special = doc.rooms.filter((r) => r.kind !== 'gallery');
  const [selected, setSelected] = useState(special[0]?.id ?? ''),
    [page, setPage] = useState(0),
    [mobile, setMobile] = useState(true),
    [overflow, setOverflow] = useState(false);
  const room = special.find((r) => r.id === selected) ?? special[0];
  const updatePages = (pages: string[]) =>
    change((d) => ({ ...d, rooms: d.rooms.map((r) => (r.id === room.id ? { ...r, pages } : r)) }));
  function reorder(delta: number) {
    const pages = [...room.pages],
      next = page + delta;
    [pages[page], pages[next]] = [pages[next], pages[page]];
    updatePages(pages);
    setPage(next);
  }
  return (
    <section className="contents">
      <div className="section-heading">
        <div>
          <span className="eyebrow">INFORMATION & DOWNLOADS</span>
          <h2>Room contents</h2>
          <p>Edit book pages and select artwork for gift-shop shelves.</p>
        </div>
      </div>
      {!room ? (
        <div className="empty-state">
          <BookOpen size={36} />
          <h3>No special rooms yet.</h3>
          <p>Change a room’s type to Information room or Gift shop in the floor plan.</p>
        </div>
      ) : (
        <>
          <div className="canvas-topline">
            <select
              aria-label="Special room"
              value={room.id}
              onChange={(e) => {
                setSelected(e.target.value);
                setPage(0);
              }}
            >
              {special.map((r) => (
                <option key={r.id} value={r.id}>
                  {r.name} · {r.kind}
                </option>
              ))}
            </select>
            <span className="tiny muted">Special rooms are always optional</span>
          </div>
          {room.kind === 'information' ? (
            <div className="book-author">
              <div>
                <div className="page-tabs">
                  {room.pages.map((_, i) => (
                    <button
                      className={page === i ? 'active' : ''}
                      key={i}
                      onClick={() => setPage(i)}
                    >
                      {i + 1}
                    </button>
                  ))}
                  <button
                    aria-label="Add book page"
                    onClick={() => {
                      updatePages([...room.pages, '']);
                      setPage(room.pages.length);
                    }}
                  >
                    <Plus size={15} />
                  </button>
                </div>
                <label>
                  Page {page + 1} · Markdown
                  <textarea
                    className="book-source"
                    value={room.pages[page] ?? ''}
                    onChange={(e) =>
                      updatePages(room.pages.map((p, i) => (i === page ? e.target.value : p)))
                    }
                  />
                </label>
                <div className="button-row">
                  <button className="secondary" disabled={page === 0} onClick={() => reorder(-1)}>
                    <ArrowUp size={14} /> Earlier
                  </button>
                  <button
                    className="secondary"
                    disabled={page >= room.pages.length - 1}
                    onClick={() => reorder(1)}
                  >
                    <ArrowDown size={14} /> Later
                  </button>
                  <button
                    className="icon-button danger"
                    aria-label="Delete page"
                    disabled={room.pages.length < 2}
                    onClick={() => {
                      updatePages(room.pages.filter((_, i) => i !== page));
                      setPage(Math.max(0, page - 1));
                    }}
                  >
                    <Trash2 size={15} />
                  </button>
                </div>
                <p
                  className={`tiny ${overflow || !bookPageFits(room.pages[page] ?? '') ? 'error' : 'muted'}`}
                >
                  {overflow || !bookPageFits(room.pages[page] ?? '')
                    ? 'This page may overflow. Shorten it or split it into another page before publishing.'
                    : 'This page fits the supported reading size.'}
                </p>
                <p className="tiny muted">
                  Supported: headings, paragraphs, emphasis, lists, quotes, and links. Embedded HTML
                  and images are disabled.
                </p>
              </div>
              <div className="book-preview">
                <div className="segmented">
                  <button className={mobile ? 'active' : ''} onClick={() => setMobile(true)}>
                    Mobile
                  </button>
                  <button className={!mobile ? 'active' : ''} onClick={() => setMobile(false)}>
                    Desktop
                  </button>
                </div>
                <div className={`book-paper ${mobile ? 'mobile' : ''}`}>
                  <BookPage text={room.pages[page] ?? ''} onOverflow={setOverflow} />
                  <div className="book-footer">
                    {String(page + 1).padStart(2, '0')} <span>{room.name}</span>
                  </div>
                </div>
              </div>
            </div>
          ) : (
            <div className="shop-settings">
              <div className="notice">
                <ShoppingBag size={20} />
                <p>
                  The kiosk includes only displayed artworks with download permission. Shelf images
                  are decoration and do not change permissions.
                </p>
              </div>
              <h3>Decorate the shelves</h3>
              <div className="shelf-grid">
                {doc.assets
                  .filter((a) => doc.regions.some((r) => r.assetId === a.id))
                  .map((a) => (
                    <label key={a.id} className="shelf-choice">
                      <Image asset={a} />
                      <span>
                        <input
                          type="checkbox"
                          checked={room.shelves.includes(a.id)}
                          onChange={(e) =>
                            change((d) => ({
                              ...d,
                              rooms: d.rooms.map((r) =>
                                r.id === room.id
                                  ? {
                                      ...r,
                                      shelves: e.target.checked
                                        ? [...r.shelves, a.id]
                                        : r.shelves.filter((id) => id !== a.id),
                                    }
                                  : r,
                              ),
                            }))
                          }
                        />
                        {a.title}
                      </span>
                    </label>
                  ))}
              </div>
            </div>
          )}
        </>
      )}
    </section>
  );
}
