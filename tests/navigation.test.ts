import { describe, expect, it } from 'vitest';
import { sample } from '../src/core/sample';
import { center, defaultRoom, distance, type MuseumDocument } from '../src/core/model';
import {
  compile,
  walkStep,
  surfaceHeight,
  navigationStops,
  avoidOpenings,
  routeBetween,
} from '../src/core/layout';
import { addRoom, constructionProblems } from '../src/core/operations';

describe('walking and automatic furnishing', () => {
  it('moves in all four camera-relative directions at equal speed, including diagonals', () => {
    const room = defaultRoom(0, 0);
    const doc = { ...sample, entrance: room.id, rooms: [room], connections: [], regions: [] };
    const layout = compile(doc),
      origin = center(room);
    for (const yaw of [0, Math.PI / 4, Math.PI / 2, Math.PI, Math.PI * 1.75])
      for (const [forward, right] of [
        [1, 0],
        [-1, 0],
        [0, 1],
        [0, -1],
        [1, 1],
      ]) {
        const result = walkStep(layout, origin, yaw, forward, right, 0.5);
        expect(distance(result, origin)).toBeCloseTo(1.2, 6);
        const norm = Math.hypot(forward, right);
        expect(result.x).toBeCloseTo(
          ((Math.sin(yaw) * forward + Math.cos(yaw) * right) * 1.2) / norm,
        );
        expect(result.z).toBeCloseTo(
          ((Math.cos(yaw) * forward - Math.sin(yaw) * right) * 1.2) / norm,
        );
      }
  });

  it('slides along walls and crosses the shop doorway in both directions', () => {
    const layout = compile(sample);
    const slide = walkStep(layout, { x: 2.74, y: 0, z: -6 }, 0, 1, 1, 0.3);
    expect(slide.z).toBeGreaterThan(-6);
    for (const direction of [-1, 1]) {
      let body = { x: direction === 1 ? 8 : 9.6, y: 0, z: -6 };
      for (let n = 0; n < 60; n++) body = walkStep(layout, body, Math.PI / 2, direction, 0, 1 / 60);
      if (direction === 1) expect(body.x).toBeGreaterThan(9.3);
      else expect(body.x).toBeCloseTo(7.2, 4);
    }
  });

  it('fits shelves and stands around all door orientations and either stair type', () => {
    for (const rotation of [0, 1, 2, 3]) {
      const doc = structuredClone(sample);
      doc.rooms = doc.rooms.map((r) => ({ ...r, rotation }));
      doc.regions = [];
      const layout = compile(doc);
      expect(layout.issues).toEqual([]);
      expect(layout.furnishings.filter((f) => f.roomId === 'shop')).toHaveLength(2);
      for (const f of layout.furnishings) {
        expect(surfaceHeight(layout, f, f)).toBeNull();
        for (const wall of layout.walls.filter((w) => w.roomId === f.roomId && w.opening)) {
          const horizontal = wall.side === 'north' || wall.side === 'south';
          const normal = horizontal ? Math.abs(f.z - wall.center.z) : Math.abs(f.x - wall.center.x);
          const along = horizontal ? Math.abs(f.x - wall.center.x) : Math.abs(f.z - wall.center.z);
          expect(normal > 1.6 || along > 1.1 + (horizontal ? f.w : f.d) / 2).toBe(true);
        }
      }
    }
  });

  it('keeps every navigation stop reachable without crossing furniture or floor holes', () => {
    const layout = compile(sample),
      stops = navigationStops(sample, layout);
    expect(stops).toHaveLength(sample.rooms.length);
    for (const stop of stops) {
      const room = sample.rooms.find((r) => r.id === stop.roomId)!;
      if (stop.label === 'Stair landing') {
        expect(Math.hypot(stop.x - room.x * 6, stop.z - room.z * 6)).toBeGreaterThan(2.1);
      } else {
        // Viewing stops stay at least two metres away from every artwork wall.
        expect(Math.abs(stop.x - room.x * 6)).toBeLessThanOrEqual(1);
        expect(Math.abs(stop.z - room.z * 6)).toBeLessThanOrEqual(1);
      }
    }
    for (const room of sample.rooms) expect(stops.some((s) => s.roomId === room.id)).toBe(true);
    for (const stop of stops) {
      expect(surfaceHeight(layout, stop, stop)).toBeCloseTo(stop.y);
      const start = stops.find((s) => s.roomId === sample.entrance && s.x === 0 && s.z === 0)!;
      const path = avoidOpenings(layout, [
        start,
        ...routeBetween(layout, start.roomId, stop.roomId),
        stop,
      ]);
      expect(path.length, `route to ${JSON.stringify(stop)}`).toBeGreaterThan(1);
      expect(path.at(-1)).toMatchObject({ x: stop.x, y: stop.y, z: stop.z });
      for (let i = 1; i < path.length; i++) {
        const a = path[i - 1],
          b = path[i],
          steps = Math.ceil(distance(a, b) / 0.05);
        let prev = a;
        for (let n = 1; n <= steps; n++) {
          const t = n / steps,
            p = { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t, z: a.z + (b.z - a.z) * t };
          expect(surfaceHeight(layout, p, prev), `blocked ${JSON.stringify(p)}`).not.toBeNull();
          prev = p;
        }
      }
    }
  });

  it('rejects construction on a stair footprint before saving the edit', () => {
    const next = addRoom(structuredClone(sample), { ...defaultRoom(1, 0), id: 'blocked-stair' });
    expect(constructionProblems(sample, next).some((p) => p.code === 'stairs')).toBe(true);
  });

  it('rejects a shop when all wall sections are merged away', () => {
    const main = { ...defaultRoom(0, 0), id: 'main' };
    let doc: MuseumDocument = {
      ...structuredClone(sample),
      rooms: [main],
      entrance: main.id,
      connections: [],
      regions: [],
    };
    for (const [x, z] of [
      [0, -1],
      [1, 0],
      [0, 1],
      [-1, 0],
    ])
      doc = addRoom(doc, defaultRoom(x, z));
    doc.connections = doc.connections.map((c) => ({ ...c, kind: 'merged' }));
    const next: MuseumDocument = {
      ...doc,
      rooms: doc.rooms.map((r) => (r.id === main.id ? { ...r, kind: 'shop' } : r)),
    };
    expect(constructionProblems(doc, next).some((p) => p.code === 'furnishing')).toBe(true);
    expect(doc.rooms[0].kind).toBe('gallery');
  });
});
