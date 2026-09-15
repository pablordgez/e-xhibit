import { useState } from 'react';
import {
  DoorOpen,
  Layers,
  Maximize,
  Minus,
  Plus,
  RotateCw,
  Move,
  Trash2,
  Info,
  ShoppingBag,
  Flag,
  ArrowUpRight,
} from 'lucide-react';
import {
  type MuseumDocument,
  type Room,
  type Connection,
  defaultRoom,
  uid,
  center,
} from '../core/model';
import { compile } from '../core/layout';
import { addRoom, deleteRoom, reconcile } from '../core/operations';
type Props = {
  doc: MuseumDocument;
  change: (fn: (d: MuseumDocument) => MuseumDocument) => void;
  selected: string;
  select: (id: string) => void;
  floor: number;
  setFloor: (floor: number) => void;
  editWall: () => void;
};
export default function FloorPlan({
  doc,
  change,
  selected,
  select,
  floor,
  setFloor,
  editWall,
}: Props) {
  const [tool, setTool] = useState<'select' | 'add' | 'move'>('select'),
    [zoom, setZoom] = useState(1),
    [target, setTarget] = useState(''),
    [kind, setKind] = useState<Connection['kind']>('door'),
    [waypoints, setWaypoints] = useState(''),
    [error, setError] = useState('');
  const room = doc.rooms.find((r) => r.id === selected),
    layout = compile(doc),
    rooms = doc.rooms.filter((r) => r.floor === floor),
    size = 88 * zoom;
  const xs = rooms.map((r) => r.x),
    zs = rooms.map((r) => r.z),
    minX = Math.min(0, ...xs) - 1,
    minZ = Math.min(0, ...zs) - 1,
    maxX = Math.max(1, ...xs) + 1,
    maxZ = Math.max(0, ...zs) + 1;
  const cols = maxX - minX + 1,
    rows = maxZ - minZ + 1;
  function place(x: number, z: number) {
    if (tool === 'add') {
      const r = defaultRoom(x, z, floor);
      r.name = `Gallery ${doc.rooms.length + 1}`;
      change((d) => addRoom(d, r));
      select(r.id);
      setTool('select');
    } else if (tool === 'move' && room) {
      change((d) =>
        reconcile({
          ...d,
          rooms: d.rooms.map((r) => (r.id === room.id ? { ...r, x, z, floor } : r)),
        }),
      );
      setTool('select');
    }
  }
  function connect() {
    if (!room || !target) return;
    try {
      const route = waypoints.trim()
        ? waypoints.split(';').map((pair) => {
            const [x, z] = pair.trim().split(',').map(Number);
            if (!Number.isInteger(x) || !Number.isInteger(z))
              throw Error('Use whole-metre coordinates: x,z; x,z');
            return { x, z };
          })
        : [];
      const connection: Connection = { id: uid(), a: room.id, b: target, kind, route };
      change((d) =>
        reconcile({
          ...d,
          connections: [
            ...d.connections.filter(
              (c) => !((c.a === room.id && c.b === target) || (c.b === room.id && c.a === target)),
            ),
            connection,
          ],
        }),
      );
      setError('');
    } catch (e) {
      setError((e as Error).message);
    }
  }
  const mutate = (patch: Partial<Room>) =>
    change((d) =>
      reconcile({ ...d, rooms: d.rooms.map((r) => (r.id === selected ? { ...r, ...patch } : r)) }),
    );
  return (
    <div className="workspace-body">
      <div className="plan-area">
        <div className="canvas-topline">
          <div className="segmented">
            <button className={tool === 'select' ? 'active' : ''} onClick={() => setTool('select')}>
              Select
            </button>
            <button className={tool === 'add' ? 'active' : ''} onClick={() => setTool('add')}>
              <Plus size={15} /> Add room
            </button>
            <button
              className={tool === 'move' ? 'active' : ''}
              disabled={!room}
              onClick={() => setTool('move')}
            >
              <Move size={14} /> Move
            </button>
          </div>
          <span className="muted tiny">1 module = 6 × 6 m</span>
        </div>
        <div className="plan-scroll">
          <div
            className={`floor-grid tool-${tool}`}
            style={{
              width: cols * size,
              height: rows * size,
              gridTemplateColumns: `repeat(${cols}, ${size}px)`,
              gridTemplateRows: `repeat(${rows}, ${size}px)`,
            }}
          >
            {Array.from({ length: cols * rows }, (_, i) => {
              const x = (i % cols) + minX,
                z = Math.floor(i / cols) + minZ;
              return (
                <button
                  key={`${x},${z}`}
                  className="grid-cell"
                  aria-label={`Place room at ${x}, ${z}`}
                  onClick={() => place(x, z)}
                  disabled={tool === 'select' || rooms.some((r) => r.x === x && r.z === z)}
                >
                  {tool === 'add' && <Plus size={16} />}
                </button>
              );
            })}
            <svg
              className="connections-layer"
              width={cols * size}
              height={rows * size}
              aria-hidden="true"
            >
              {doc.connections
                .filter((c) => c.kind === 'corridor')
                .map((c) => {
                  const a = doc.rooms.find((r) => r.id === c.a),
                    b = doc.rooms.find((r) => r.id === c.b);
                  if (!a || !b || a.floor !== floor) return null;
                  return (
                    <polyline
                      key={c.id}
                      points={[center(a), ...c.route, center(b)]
                        .map(
                          (p) =>
                            `${(p.x / 6 - minX + 0.5) * size},${(p.z / 6 - minZ + 0.5) * size}`,
                        )
                        .join(' ')}
                      stroke="#c8c8c8"
                      strokeWidth={size / 3}
                      fill="none"
                    />
                  );
                })}
            </svg>
            {rooms.map((r) => (
              <button
                key={r.id}
                onClick={() => select(r.id)}
                className={`plan-room ${r.id === selected ? 'selected' : ''} ${r.kind}`}
                style={{
                  left: (r.x - minX) * size + 3,
                  top: (r.z - minZ) * size + 3,
                  width: size - 6,
                  height: size - 6,
                  backgroundColor: r.id === selected ? undefined : r.color,
                }}
                title={r.name}
              >
                <span className="room-number">
                  {String(doc.rooms.indexOf(r) + 1).padStart(2, '0')}
                </span>
                {r.kind === 'information' ? (
                  <Info size={17} />
                ) : r.kind === 'shop' ? (
                  <ShoppingBag size={17} />
                ) : r.id === doc.entrance ? (
                  <Flag size={16} />
                ) : (
                  <span className="room-line" />
                )}
                <span className="room-floor-name">{r.name}</span>
                {doc.connections.some(
                  (c) => (c.a === r.id || c.b === r.id) && ['stairs', 'spiral'].includes(c.kind),
                ) && <span className="stair-indicator">↗</span>}
              </button>
            ))}
            {doc.connections
              .filter((c) => ['door', 'merged', 'closed'].includes(c.kind))
              .map((c) => {
                const a = rooms.find((r) => r.id === c.a),
                  b = rooms.find((r) => r.id === c.b);
                if (!a || !b) return null;
                const vertical = a.x !== b.x;
                return (
                  <span
                    key={c.id}
                    className={`plan-door ${c.kind} ${vertical ? 'vertical' : ''}`}
                    style={{
                      left: ((a.x + b.x) / 2 - minX + 0.5) * size,
                      top: ((a.z + b.z) / 2 - minZ + 0.5) * size,
                    }}
                  />
                );
              })}
          </div>
        </div>
        <div className="canvas-bottomline">
          <div className="floor-control">
            <Layers size={16} />
            <select
              aria-label="Current floor"
              value={floor}
              onChange={(e) => setFloor(Number(e.target.value))}
            >
              {[0, 1, 2, 3, 4].map((f) => (
                <option key={f} value={f}>
                  {f === 0 ? 'Ground floor' : `Floor ${f + 1}`}
                </option>
              ))}
            </select>
          </div>
          <div className="canvas-legend">
            <i /> Gallery <i className="orange" /> Selected <i className="stripe" /> Connection
          </div>
          <div className="zoom-control">
            <button aria-label="Zoom out" onClick={() => setZoom((z) => Math.max(0.6, z - 0.1))}>
              <Minus size={14} />
            </button>
            <span>{Math.round(zoom * 100)}%</span>
            <button aria-label="Zoom in" onClick={() => setZoom((z) => Math.min(1.6, z + 0.1))}>
              <Plus size={14} />
            </button>
            <button aria-label="Reset zoom" onClick={() => setZoom(1)}>
              <Maximize size={14} />
            </button>
          </div>
        </div>
        <div className="canvas-hint">
          {tool === 'add'
            ? 'Choose an empty cell. Adjacent rooms connect automatically.'
            : tool === 'move'
              ? 'Choose an empty destination. Check connections after moving.'
              : 'Select a room to make it your own. Add rooms to grow your museum.'}
        </div>
      </div>
      <aside className="inspector">
        {room ? (
          <>
            <div className="inspector-title">
              <span className="eyebrow">ROOM PROPERTIES</span>
              <span className="room-badge">
                {String(doc.rooms.indexOf(room) + 1).padStart(2, '0')}
              </span>
            </div>
            <label>
              Room name
              <input value={room.name} onChange={(e) => mutate({ name: e.target.value })} />
            </label>
            <label>
              Room type
              <select
                value={room.kind}
                onChange={(e) => mutate({ kind: e.target.value as Room['kind'] })}
              >
                <option value="gallery">Gallery</option>
                <option value="information">Information room</option>
                <option value="shop">Gift shop</option>
              </select>
            </label>
            <div className="property-pair">
              <div>
                <span className="field-label">Dimensions</span>
                <strong>6 × 6 m</strong>
              </div>
              <div>
                <span className="field-label">Area</span>
                <strong>36 m²</strong>
              </div>
            </div>
            <hr />
            <span className="eyebrow">LOOK & FEEL</span>
            <label className="inline-label">
              Wall color
              <input
                type="color"
                value={room.color}
                onChange={(e) => mutate({ color: e.target.value })}
              />
            </label>
            <label>
              Floor finish
              <select
                value={room.finish}
                onChange={(e) => mutate({ finish: e.target.value as Room['finish'] })}
              >
                <option value="wood">Natural oak</option>
                <option value="stone">Warm stone</option>
              </select>
            </label>
            <button className="secondary full" onClick={editWall}>
              Arrange this room’s walls <ArrowUpRight size={15} />
            </button>
            <div className="button-row">
              <button
                className="secondary"
                onClick={() => mutate({ rotation: (room.rotation + 1) % 4 })}
              >
                <RotateCw size={14} /> Rotate room
              </button>
              <button
                className="icon-button danger"
                aria-label="Delete room"
                disabled={doc.rooms.length === 1}
                onClick={() => {
                  change((d) => deleteRoom(d, room.id));
                  select(doc.rooms.find((r) => r.id !== room.id)!.id);
                }}
              >
                <Trash2 size={16} />
              </button>
            </div>
            <hr />
            <span className="eyebrow">CONNECTIONS</span>
            <div className="connection-list">
              {doc.connections
                .filter((c) => c.a === room.id || c.b === room.id)
                .map((c) => (
                  <div key={c.id}>
                    <DoorOpen size={14} />
                    <span>
                      {doc.rooms.find((r) => r.id === (c.a === room.id ? c.b : c.a))?.name}
                      <small>{c.kind}</small>
                    </span>
                    <button
                      className="icon-button"
                      aria-label="Remove connection"
                      onClick={() =>
                        change((d) =>
                          reconcile({
                            ...d,
                            connections: d.connections.filter((x) => x.id !== c.id),
                          }),
                        )
                      }
                    >
                      <Minus size={14} />
                    </button>
                  </div>
                ))}
            </div>
            <label>
              Connect to
              <select value={target} onChange={(e) => setTarget(e.target.value)}>
                <option value="">Choose a room</option>
                {doc.rooms
                  .filter((r) => r.id !== room.id)
                  .map((r) => (
                    <option key={r.id} value={r.id}>
                      {r.name} · Floor {r.floor + 1}
                    </option>
                  ))}
              </select>
            </label>
            <label>
              Connection type
              <select value={kind} onChange={(e) => setKind(e.target.value as Connection['kind'])}>
                {['door', 'merged', 'closed', 'corridor', 'stairs', 'spiral'].map((k) => (
                  <option key={k}>{k}</option>
                ))}
              </select>
            </label>
            {kind === 'corridor' && (
              <label>
                Corner coordinates (metres)
                <input
                  value={waypoints}
                  placeholder="-6,0; -6,12"
                  onChange={(e) => setWaypoints(e.target.value)}
                />
                <small>
                  World x,z pairs separated by semicolons. Room centres are grid coordinates × 6.
                </small>
              </label>
            )}
            {error && <p className="error">{error}</p>}
            <button className="secondary full" disabled={!target} onClick={connect}>
              Apply connection
            </button>
            <button
              className="text-button"
              onClick={() => change((d) => ({ ...d, entrance: room.id }))}
            >
              <Flag size={14} />{' '}
              {doc.entrance === room.id ? 'Visitor entrance' : 'Set as visitor entrance'}
            </button>
            {layout.issues
              .filter((i) => i.target === room.id)
              .map((i, n) => (
                <p key={n} className="error tiny">
                  {i.message}
                </p>
              ))}
          </>
        ) : (
          <p>Select a room on the plan.</p>
        )}
      </aside>
    </div>
  );
}
