import {
  HEIGHT,
  STOREY,
  center,
  type MuseumDocument,
  type Ramp,
  type WalkArea,
  type Structure,
  type Vec,
} from './model';

export const HEADROOM = 2.1;
export const SLAB = 0.12;
export const CEILING_SLAB = STOREY - HEIGHT - SLAB;
export const SPIRAL_RADIUS = 2.05;

/** Keep every floor fragment on one world-space board grid. */
export function boardLines(area: WalkArea) {
  const lines: number[] = [];
  const start = Math.ceil((area.z - area.d / 2 + 0.0001) / 0.4);
  for (let i = start; i * 0.4 < area.z + area.d / 2 - 0.0001; i++) lines.push(i * 0.4);
  return lines;
}

/** Low treads and the centre post block walking; overhead treads do not. */
export function spiralObstructs(area: WalkArea, point: Vec, height = 1.8) {
  const radius = Math.hypot(point.x - area.x, point.z - area.z);
  if (radius > SPIRAL_RADIUS + 0.13) return false;
  if (radius < 0.32) return true;
  const angle = (Math.atan2(point.z - area.z, point.x - area.x) + Math.PI * 2) % (Math.PI * 2);
  // Include the character radius when testing the lower neighbouring tread.
  const anglePadding = Math.asin(Math.min(1, 0.13 / radius));
  const underside = (Math.max(0, angle - anglePadding) / (Math.PI * 2)) * STOREY - 0.13;
  return underside < height;
}

export function contains(area: WalkArea, point: Vec, padding = 0) {
  return area.shape === 'circle'
    ? Math.hypot(point.x - area.x, point.z - area.z) < area.w / 2 + padding
    : Math.abs(point.x - area.x) < area.w / 2 + padding &&
        Math.abs(point.z - area.z) < area.d / 2 + padding;
}

export function stairArchitecture(doc: MuseumDocument, ramps: Ramp[]) {
  const holes: WalkArea[] = [],
    ceilingHoles: WalkArea[] = [],
    structures: Structure[] = [];
  for (const ramp of ramps) {
    const link = doc.connections.find((c) => c.id === ramp.id)!;
    const a = doc.rooms.find((r) => r.id === link.a)!,
      b = doc.rooms.find((r) => r.id === link.b)!;
    const low = a.floor < b.floor ? a : b,
      high = a.floor < b.floor ? b : a;
    const bottom = low.floor * STOREY,
      top = high.floor * STOREY;
    if (ramp.kind === 'spiral') {
      const opening = {
        ...center(high),
        w: 4.2,
        d: 4.2,
        roomId: high.id,
        shape: 'circle' as const,
      };
      holes.push(opening);
      ceilingHoles.push({ ...opening, y: bottom + HEIGHT, roomId: low.id });
      continue;
    }
    const points =
      ramp.points[0].y < ramp.points.at(-1)!.y ? [...ramp.points] : [...ramp.points].reverse();
    const from = points[1],
      to = points[points.length - 2];
    const dx = Math.sign(to.x - from.x),
      dz = Math.sign(to.z - from.z);
    const openingAt = (plane: number, roomId: string, underside: number): WalkArea => {
      const t = Math.max(0, Math.min(1, (underside - HEADROOM - 0.15 - bottom) / (top - bottom)));
      const start = { x: from.x + (to.x - from.x) * t, z: from.z + (to.z - from.z) * t };
      return {
        x: (start.x + to.x) / 2,
        z: (start.z + to.z) / 2,
        y: plane,
        w: dx ? Math.abs(to.x - start.x) : ramp.width + 0.1,
        d: dz ? Math.abs(to.z - start.z) : ramp.width + 0.1,
        roomId,
      };
    };
    holes.push(openingAt(top, high.id, top - SLAB));
    ceilingHoles.push(openingAt(bottom + HEIGHT, low.id, bottom + HEIGHT));
    const run = Math.hypot(to.x - from.x, to.z - from.z),
      mid = { x: (from.x + to.x) / 2, z: (from.z + to.z) / 2 };
    for (const side of [-1, 1])
      structures.push({
        name: 'stairwell-side',
        x: mid.x + dz * side * (ramp.width / 2 + 0.1),
        z: mid.z + dx * side * (ramp.width / 2 + 0.1),
        y: bottom,
        w: dx ? run + 0.24 : 0.24,
        d: dz ? run + 0.24 : 0.24,
        h: STOREY + HEIGHT,
        color: low.color,
      });
    // Close the shaft above the lower entrance instead of exposing an unbuilt room.
    structures.push({
      name: 'stairwell-end',
      x: from.x - dx * 0.06,
      z: from.z - dz * 0.06,
      y: bottom + 2.6,
      w: dx ? 0.12 : ramp.width + 0.24,
      d: dz ? 0.12 : ramp.width + 0.24,
      h: STOREY + HEIGHT - 2.6,
      color: low.color,
    });
    structures.push({
      name: 'stairwell-roof',
      ...mid,
      y: top + HEIGHT,
      w: dx ? run + 0.24 : ramp.width + 0.24,
      d: dz ? run + 0.24 : ramp.width + 0.24,
      h: SLAB,
      color: high.color,
    });
  }
  return { holes, ceilingHoles, structures };
}

/** Closed risers end exactly at the upper floor; dimensions use horizontal run. */
export function straightTreads(ramp: Ramp) {
  const points =
    ramp.points[0].y < ramp.points.at(-1)!.y ? [...ramp.points] : [...ramp.points].reverse();
  const a = points[1],
    b = points[points.length - 2];
  const run = Math.hypot(b.x - a.x, b.z - a.z),
    count = Math.ceil((b.y - a.y) / 0.15);
  return Array.from({ length: count }, (_, i) => {
    const t = (i + 0.5) / count,
      top = a.y + ((b.y - a.y) * (i + 1)) / count;
    return {
      x: a.x + (b.x - a.x) * t,
      z: a.z + (b.z - a.z) * t,
      y: a.y - SLAB,
      h: top - a.y + SLAB,
      w: ramp.width,
      d: run / count + 0.005,
      rotation: Math.atan2(b.x - a.x, b.z - a.z),
      top,
    };
  });
}

function subtract(rect: WalkArea, hole: WalkArea): WalkArea[] {
  const l = Math.max(rect.x - rect.w / 2, hole.x - hole.w / 2),
    r = Math.min(rect.x + rect.w / 2, hole.x + hole.w / 2);
  const t = Math.max(rect.z - rect.d / 2, hole.z - hole.d / 2),
    b = Math.min(rect.z + rect.d / 2, hole.z + hole.d / 2);
  if (l >= r || t >= b) return [rect];
  return [
    { ...rect, x: (rect.x - rect.w / 2 + l) / 2, w: l - (rect.x - rect.w / 2) },
    { ...rect, x: (r + rect.x + rect.w / 2) / 2, w: rect.x + rect.w / 2 - r },
    {
      ...rect,
      x: (l + r) / 2,
      z: (rect.z - rect.d / 2 + t) / 2,
      w: r - l,
      d: t - (rect.z - rect.d / 2),
    },
    {
      ...rect,
      x: (l + r) / 2,
      z: (b + rect.z + rect.d / 2) / 2,
      w: r - l,
      d: rect.z + rect.d / 2 - b,
    },
  ].filter((p) => p.w > 0.001 && p.d > 0.001);
}

/** The same openings drive the visible floor/ceiling plates and walking rules. */
export function surfacePlates(area: WalkArea, openings: WalkArea[]) {
  let plates = [area];
  for (const hole of openings.filter((h) => Math.abs(h.y - area.y) < 0.01)) {
    if (hole.shape !== 'circle') {
      plates = plates.flatMap((p) => subtract(p, hole));
      continue;
    }
    const radius = hole.w / 2,
      count = 48,
      step = hole.d / count;
    for (let i = 0; i < count; i++) {
      const near = Math.max(0, Math.abs(-radius + (i + 0.5) * step) - step / 2);
      const slice = {
        ...hole,
        z: hole.z - radius + (i + 0.5) * step,
        d: step + 0.0001,
        w: 2 * Math.sqrt(radius * radius - near * near),
        shape: undefined,
      };
      plates = plates.flatMap((p) => subtract(p, slice));
    }
  }
  return plates;
}
