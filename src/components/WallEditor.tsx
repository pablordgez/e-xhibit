import { useEffect, useState } from 'react';
import { Columns2, Rows2, Combine, Plus, Trash2, ImagePlus } from 'lucide-react';
import {
  SIDES,
  wallId,
  type MuseumDocument,
  type Region,
  type Side,
  type Frame,
} from '../core/model';
import { compile, fitExhibit } from '../core/layout';
import { initializeWall, mergeRegions, splitRegion, resizeRegion } from '../core/operations';
import { Image } from './common';
import ArtworkPicker from './ArtworkBrowser';
export default function WallEditor({
  doc,
  change,
  roomId,
  selectRoom,
  onCollection,
}: {
  doc: MuseumDocument;
  change: (fn: (d: MuseumDocument) => MuseumDocument) => void;
  roomId: string;
  selectRoom: (id: string) => void;
  onCollection: () => void;
}) {
  const [side, setSide] = useState<Side>('north'),
    [selection, setSelection] = useState<string[]>([]),
    [ratio, setRatio] = useState(0.5),
    [error, setError] = useState(''),
    [picker, setPicker] = useState(false);
  const wall = wallId(roomId, side),
    compiled = compile(doc),
    wallInfo = compiled.walls.find((w) => w.id === wall),
    regions = doc.regions.filter((r) => r.wall === wall),
    region = regions.find((r) => r.id === selection[0]),
    asset = doc.assets.find((a) => a.id === region?.assetId),
    frame = region?.frame ?? doc.defaultFrame;
  useEffect(() => {
    setSelection([]);
    setPicker(false);
  }, [wall]);
  const patch = (patch: Partial<Region>) =>
    change((d) => ({
      ...d,
      regions: d.regions.map((r) => (r.id === region?.id ? { ...r, ...patch } : r)),
    }));
  const setFrame = (patch: Partial<Frame>) => patchRegionFrame(patch);
  function patchRegionFrame(p: Partial<Frame>) {
    patch({ frame: { ...frame, ...p } });
  }
  function merge() {
    try {
      const next = mergeRegions(doc, selection);
      change(() => next);
      setSelection([]);
      setError('');
    } catch (e) {
      setError((e as Error).message);
    }
  }
  return (
    <div className="workspace-body">
      <section className="wall-area">
        <div className="canvas-topline">
          <select
            aria-label="Room to edit"
            value={roomId}
            onChange={(e) => selectRoom(e.target.value)}
          >
            {doc.rooms.map((r) => (
              <option value={r.id} key={r.id}>
                {r.name}
              </option>
            ))}
          </select>
          <div className="segmented">
            {SIDES.map((s) => (
              <button key={s} className={s === side ? 'active' : ''} onClick={() => setSide(s)}>
                {s[0].toUpperCase() + s.slice(1)}
              </button>
            ))}
          </div>
        </div>
        <div className="wall-stage">
          <span className="dimension top">6.00 m</span>
          <div
            className="wall-face"
            style={{ background: doc.rooms.find((r) => r.id === roomId)?.color }}
          >
            {!wallInfo ? (
              <div className="wall-empty">This wall has been removed by a room merge.</div>
            ) : (
              <>
                {wallInfo.opening && <div className="door-cutout">Doorway</div>}
                {regions.map((r) => {
                  const a = doc.assets.find((a) => a.id === r.assetId),
                    f = r.frame ?? doc.defaultFrame,
                    fit = fitExhibit(r, a ? a.width / a.height : 1, f, a);
                  return (
                    <button
                      key={r.id}
                      aria-label={a ? `Select ${a.title}` : 'Select empty wall region'}
                      className={`wall-region ${selection.includes(r.id) ? 'chosen' : ''}`}
                      style={{
                        left: `${(r.x / 6) * 100}%`,
                        bottom: `${(r.y / 3.8) * 100}%`,
                        width: `${(r.w / 6) * 100}%`,
                        height: `${(r.h / 3.8) * 100}%`,
                      }}
                      onClick={(e) =>
                        setSelection(
                          e.shiftKey
                            ? selection.includes(r.id)
                              ? selection.filter((id) => id !== r.id)
                              : [...selection, r.id]
                            : [r.id],
                        )
                      }
                    >
                      {a ? (
                        <div
                          className="exhibit-layout"
                          data-plaque-side={fit.plaque?.side ?? 'none'}
                        >
                          <div
                            className={`framed-image frame-${f.preset}`}
                            style={{
                              left: `${((fit.image.x - r.x) / r.w) * 100}%`,
                              bottom: `${((fit.image.y - r.y) / r.h) * 100}%`,
                              width: `${((fit.w + fit.border * 2) / r.w) * 100}%`,
                              height: `${((fit.h + fit.border * 2) / r.h) * 100}%`,
                              borderWidth: f.preset === 'none' ? 0 : `${(f.width / 6) * 100}cqw`,
                              padding: `${(f.mat / 6) * 100}cqw`,
                            }}
                          >
                            <Image asset={a} size="1024" />
                          </div>
                          {fit.plaque && (
                            <svg
                              className="mini-plaque"
                              aria-hidden="true"
                              viewBox={`0 0 ${fit.plaque.w} ${fit.plaque.h}`}
                              style={{
                                left: `${((fit.plaque.x - r.x) / r.w) * 100}%`,
                                bottom: `${((fit.plaque.y - r.y) / r.h) * 100}%`,
                                width: `${(fit.plaque.w / r.w) * 100}%`,
                                height: `${(fit.plaque.h / r.h) * 100}%`,
                              }}
                            >
                              <rect width={fit.plaque.w} height={fit.plaque.h} fill="#f7f4ed" />
                              {fit.plaque.lines.map((line, i) => (
                                <text
                                  key={i}
                                  x={0.025}
                                  y={line.baseline}
                                  fontSize={line.size}
                                  fontFamily={
                                    line.kind === 'title' ? 'Georgia, serif' : 'sans-serif'
                                  }
                                  fontWeight={line.kind === 'title' ? 'bold' : 'normal'}
                                  fill="#333a31"
                                >
                                  {line.text}
                                </text>
                              ))}
                            </svg>
                          )}
                        </div>
                      ) : (
                        <div className="region-empty">
                          <ImagePlus size={22} />
                          <span>Place an artwork</span>
                        </div>
                      )}
                      <span className="region-size">
                        {r.w.toFixed(1)} × {r.h.toFixed(1)} m
                      </span>
                    </button>
                  );
                })}
              </>
            )}
          </div>
          <span className="dimension bottom">
            Wall elevation · Images retain their original proportions
          </span>
        </div>
        <div className="wall-toolbar">
          <button
            className="secondary"
            disabled={!wallInfo || regions.length > 0}
            onClick={() => change((d) => initializeWall(d, roomId, side))}
          >
            <Plus size={15} /> Add wall grid
          </button>
          <button
            className="secondary"
            disabled={!region}
            onClick={() => change((d) => splitRegion(d, region!.id, 'x', ratio))}
          >
            <Columns2 size={16} /> Split vertically
          </button>
          <button
            className="secondary"
            disabled={!region}
            onClick={() => change((d) => splitRegion(d, region!.id, 'y', ratio))}
          >
            <Rows2 size={16} /> Split horizontally
          </button>
          <button className="secondary" disabled={selection.length < 2} onClick={merge}>
            <Combine size={16} /> Merge
          </button>
        </div>
        <p className="muted tiny centered">Shift-click to select adjacent regions for merging.</p>
        {error && <p className="error centered">{error}</p>}
        {doc.unplaced.length > 0 && (
          <div className="unplaced">
            <h3>
              Needs placement <span>{doc.unplaced.length}</span>
            </h3>
            <p>
              These exhibits came from a wall that changed. Select an empty region, then restore an
              exhibit.
            </p>
            {doc.unplaced.map((r) => (
              <div key={r.id}>
                <span>{doc.assets.find((a) => a.id === r.assetId)?.title}</span>
                <button
                  disabled={!region || Boolean(region.assetId)}
                  onClick={() =>
                    change((d) => ({
                      ...d,
                      regions: d.regions.map((x) =>
                        x.id === region!.id
                          ? {
                              ...x,
                              assetId: r.assetId,
                              frame: r.frame,
                              plaque: r.plaque,
                              plaqueAuto: r.plaqueAuto,
                            }
                          : x,
                      ),
                      unplaced: d.unplaced.filter((x) => x.id !== r.id),
                    }))
                  }
                >
                  Place here
                </button>
                <button
                  className="icon-button"
                  aria-label="Remove unplaced exhibit"
                  onClick={() =>
                    change((d) => ({ ...d, unplaced: d.unplaced.filter((x) => x.id !== r.id) }))
                  }
                >
                  <Trash2 size={14} />
                </button>
              </div>
            ))}
          </div>
        )}
      </section>
      <aside className="inspector">
        <span className="eyebrow">EXHIBIT PROPERTIES</span>
        {region ? (
          <>
            <div className="artwork-choice">
              <span className="field-label">Artwork</span>
              <button
                className="secondary full"
                aria-haspopup="dialog"
                onClick={() => setPicker(true)}
              >
                <ImagePlus size={16} /> {asset ? 'Change artwork' : 'Choose artwork'}
              </button>
              <p className="tiny muted">{asset?.title ?? 'Empty region'}</p>
            </div>
            {asset && (
              <>
                <div className="inspector-art">
                  <Image asset={asset} />
                </div>
                <p className="tiny muted">
                  {asset.width} × {asset.height} px · Original proportions
                </p>
              </>
            )}
            <label>
              Explanation plaque
              <select
                aria-label="Explanation plaque"
                value={
                  region.plaque === 'none'
                    ? 'none'
                    : region.plaqueAuto === false
                      ? region.plaque
                      : 'auto'
                }
                onChange={(e) =>
                  patch(
                    e.target.value === 'auto'
                      ? { plaque: 'below', plaqueAuto: true }
                      : { plaque: e.target.value as Region['plaque'], plaqueAuto: false },
                  )
                }
              >
                <option value="auto">Automatic (largest image)</option>
                <option value="none">Hidden</option>
                <option value="right">Beside the image</option>
                <option value="below">Below the image</option>
              </select>
            </label>
            {asset && region.plaque !== 'none' && region.plaqueAuto !== false && (
              <p className="tiny muted">
                {fitExhibit(region, asset.width / asset.height, frame, asset).plaque?.side ===
                'right'
                  ? 'Placed beside the image for more artwork space.'
                  : 'Placed below the image for more artwork space.'}
              </p>
            )}
            <hr />
            <span className="eyebrow">FRAME & MAT</span>
            <label>
              Frame style
              <select
                value={frame.preset}
                onChange={(e) => setFrame({ preset: e.target.value as Frame['preset'] })}
              >
                {['none', 'black', 'white', 'wood', 'gold'].map((f) => (
                  <option key={f} value={f}>
                    {f === 'none' ? 'Frameless' : f[0].toUpperCase() + f.slice(1)}
                  </option>
                ))}
              </select>
            </label>
            <label>
              Frame width <span>{Math.round(frame.width * 100)} cm</span>
              <input
                type="range"
                min=".01"
                max=".2"
                step=".01"
                value={frame.width}
                onChange={(e) => setFrame({ width: Number(e.target.value) })}
              />
            </label>
            <label>
              Mat border <span>{Math.round(frame.mat * 100)} cm</span>
              <input
                type="range"
                min="0"
                max=".25"
                step=".01"
                value={frame.mat}
                onChange={(e) => setFrame({ mat: Number(e.target.value) })}
              />
            </label>
            <button className="text-button" onClick={() => patch({ frame: undefined })}>
              Use museum default
            </button>
            <hr />
            <label>
              Split position <span>{Math.round(ratio * 100)}%</span>
              <input
                type="range"
                min=".2"
                max=".8"
                step=".05"
                value={ratio}
                onChange={(e) => setRatio(Number(e.target.value))}
              />
            </label>
            <span className="eyebrow">REGION SIZE</span>
            <div className="property-pair">
              {(['w', 'h'] as const).map((k) => (
                <label key={k}>
                  {k === 'w' ? 'Width' : 'Height'} (m)
                  <input
                    type="number"
                    min=".2"
                    max={k === 'w' ? 6 : 3.8}
                    step=".05"
                    value={region[k]}
                    onChange={(e) => {
                      const v = Number(e.target.value);
                      if (v > 0) {
                        try {
                          const next = resizeRegion(doc, region.id, k, v);
                          change(() => next);
                          setError('');
                        } catch (e) {
                          setError((e as Error).message);
                        }
                      }
                    }}
                  />
                </label>
              ))}
            </div>
            <p className="tiny muted">
              Shared dividers resize their neighboring regions together. Images scale to fit without
              cropping.
            </p>
            <button
              className="secondary full danger"
              onClick={() => {
                change((d) => ({
                  ...d,
                  regions: d.regions.filter((r) => r.id !== region.id),
                  unplaced: region.assetId ? [...d.unplaced, region] : d.unplaced,
                }));
                setSelection([]);
              }}
            >
              <Trash2 size={14} /> Remove region
            </button>
            {compiled.issues
              .filter((i) => i.target === region.id)
              .map((i, n) => (
                <p className="error tiny" key={n}>
                  {i.message}
                </p>
              ))}
          </>
        ) : (
          <div className="inspector-placeholder">
            <Columns2 size={32} />
            <h3>A place for every piece.</h3>
            <p>Select a wall region to add artwork, adjust its frame, or change the layout.</p>
          </div>
        )}
      </aside>
      {picker && region && (
        <ArtworkPicker
          doc={doc}
          selected={region.assetId}
          onClose={() => setPicker(false)}
          onCollection={() => {
            setPicker(false);
            onCollection();
          }}
          onSelect={(assetId) => {
            patch({ assetId });
            setPicker(false);
          }}
        />
      )}
    </div>
  );
}
