import { describe, it, expect } from 'vitest';
import { museumSchema, defaultRoom } from '../src/core/model';
import { sample } from '../src/core/sample';
import {
  compile,
  fitExhibit,
  routeBetween,
  surfaceHeight,
  bookPageFits,
  avoidOpenings,
} from '../src/core/layout';
import {
  addRoom,
  deleteRoom,
  initializeWall,
  splitRegion,
  mergeRegions,
  reconcile,
} from '../src/core/operations';
import { dimensions } from '../src/lib/images';
const fresh = () => structuredClone(sample);
describe('shared museum compiler', () => {
  it('accepts the sample museum and reaches both stair types', () => {
    const doc = museumSchema.parse(sample),
      layout = compile(doc);
    expect(layout.issues).toEqual([]);
    expect(layout.ramps.map((r) => r.kind).sort()).toEqual(['spiral', 'stairs']);
    for (const room of doc.rooms.filter((r) => r.id !== doc.entrance))
      expect(routeBetween(layout, doc.entrance, room.id).length).toBeGreaterThan(0);
  });
  it('rejects overlapping rooms and disconnected floors', () => {
    const doc = fresh();
    doc.rooms.push({ ...defaultRoom(0, 0), id: 'overlap' });
    expect(compile(doc).issues.map((i) => i.code)).toEqual(
      expect.arrayContaining(['overlap', 'unreachable']),
    );
  });
  it('rejects diagonal corridors', () => {
    const doc = fresh();
    doc.connections.find((c) => c.kind === 'corridor')!.route = [{ x: -6, z: 5 }];
    expect(compile(doc).issues.some((i) => i.code === 'corridor')).toBe(true);
  });
  it('requires vertically aligned spiral endpoints', () => {
    const doc = fresh();
    doc.rooms.find((r) => r.id === 'upper')!.x = 3;
    expect(compile(doc).issues.some((i) => i.code === 'stairs')).toBe(true);
  });
  it('adds a doorway automatically', () => {
    const doc = fresh(),
      room = defaultRoom(-1, -1);
    const next = addRoom(doc, room);
    expect(next.connections.some((c) => c.kind === 'door' && c.b === room.id)).toBe(true);
  });
  it('preserves exhibits when their room disappears', () => {
    const doc = deleteRoom(fresh(), 'reading');
    expect(doc.assets.some((a) => a.id === 'art-6')).toBe(true);
    expect(doc.unplaced.some((r) => r.assetId === 'art-6')).toBe(true);
    expect(compile(doc).issues.some((i) => i.code === 'unplaced')).toBe(true);
  });
  it('recovers exhibits when a wall becomes a doorway', () => {
    const doc = fresh();
    doc.connections.push({ id: 'door-wall', a: 'reading', b: 'light', kind: 'door', route: [] });
    const next = reconcile({
      ...doc,
      connections: doc.connections.filter((c) => c.id !== 'door-wall'),
    });
    expect(next.assets).toEqual(doc.assets);
  });
  it('keeps movement inside the museum', () => {
    expect(
      surfaceHeight(compile(fresh()), { x: 100, y: 0, z: 100 }, { x: 0, y: 0, z: 0 }),
    ).toBeNull();
  });
  it('provides continuous ascending and descending stair surfaces', () => {
    const layout = compile(fresh());
    for (const ramp of layout.ramps) {
      for (let i = 1; i < ramp.points.length; i++) {
        const a = ramp.points[i - 1],
          b = ramp.points[i];
        let previous = { ...a };
        for (let t = 0.05; t <= 1; t += 0.05) {
          const p = {
            x: a.x + (b.x - a.x) * t,
            y: a.y + (b.y - a.y) * t,
            z: a.z + (b.z - a.z) * t,
          };
          expect(surfaceHeight(layout, p, previous)).not.toBeNull();
          previous = p;
        }
      }
    }
  });
  it('keeps guided routes on walkable surfaces between every pair of rooms', () => {
    const doc = fresh(),
      layout = compile(doc);
    for (const a of doc.rooms)
      for (const b of doc.rooms) {
        if (a.id === b.id) continue;
        const path = avoidOpenings(layout, routeBetween(layout, a.id, b.id));
        expect(path.length, `${a.id} -> ${b.id} must have a route`).toBeGreaterThan(1);
        for (let i = 1; i < path.length; i++) {
          const p = path[i - 1],
            q = path[i];
          let previous = { ...p };
          const steps = Math.max(1, Math.ceil(Math.hypot(q.x - p.x, q.y - p.y, q.z - p.z) / 0.05));
          for (let n = 1; n <= steps; n++) {
            const t = n / steps,
              next = {
                x: p.x + (q.x - p.x) * t,
                y: p.y + (q.y - p.y) * t,
                z: p.z + (q.z - p.z) * t,
              };
            expect(
              surfaceHeight(layout, next, previous),
              `${a.id} -> ${b.id} at ${JSON.stringify(next)}`,
            ).not.toBeNull();
            previous = next;
          }
        }
      }
  });
});
describe('wall layouts and proportions', () => {
  it('initializes regions around door openings', () => {
    let doc = fresh();
    doc.regions = doc.regions.filter((r) => r.wall !== 'welcome:north');
    doc = initializeWall(doc, 'welcome', 'north');
    expect(doc.regions.filter((r) => r.wall === 'welcome:north')).toHaveLength(2);
    expect(compile(doc).issues.some((i) => i.code === 'door')).toBe(false);
  });
  it('splits and merges without duplicating an image', () => {
    const doc = fresh(),
      r = doc.regions[0],
      split = splitRegion(doc, r.id, 'x', 0.4),
      parts = split.regions.filter((x) => x.wall === r.wall && x.x < r.x + r.w);
    expect(parts).toHaveLength(2);
    expect(parts.filter((r) => r.assetId)).toHaveLength(1);
    const merged = mergeRegions(
      split,
      parts.map((r) => r.id),
    );
    expect(merged.regions.find((x) => x.id === r.id)?.w).toBeCloseTo(r.w);
  });
  it('does not discard multiple occupied cells on merge', () => {
    const doc = fresh();
    expect(() =>
      mergeRegions(
        doc,
        doc.regions.slice(0, 2).map((r) => r.id),
      ),
    ).toThrow();
  });
  it('preserves arbitrary image aspect ratios for every variant', () => {
    for (const [w, h] of [
      [3000, 2000],
      [700, 3000],
      [4000, 800],
      [919, 1273],
    ])
      for (const edge of [512, 1024, 2048]) {
        const d = dimensions(w, h, edge);
        expect(Math.max(d.width, d.height)).toBeLessThanOrEqual(edge);
        expect(Math.abs(d.width / d.height - w / h)).toBeLessThan(0.02);
      }
  });
  it('shows images larger in merged cells without changing proportions', () => {
    const r = fresh().regions[0];
    const small = fitExhibit({ ...r, w: 1, h: 2, plaque: 'none' }, 0.7, sample.defaultFrame),
      large = fitExhibit({ ...r, w: 3, h: 3, plaque: 'none' }, 0.7, sample.defaultFrame);
    expect(large.w).toBeGreaterThan(small.w);
    expect(small.w / small.h).toBeCloseTo(0.7);
    expect(large.w / large.h).toBeCloseTo(0.7);
  });
  it('rejects impossible frames and overflowing books', () => {
    expect(fitExhibit({ ...sample.regions[0], w: 0.2, h: 0.2 }, 2, sample.defaultFrame).fits).toBe(
      false,
    );
    expect(bookPageFits('long '.repeat(1000))).toBe(false);
  });
});
