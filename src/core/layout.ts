import {
  MODULE,
  STOREY,
  HEIGHT,
  SIDES,
  center,
  facing,
  sideDelta,
  wallId,
  distance,
  physicalSide,
  localSide,
  type MuseumDocument,
  type Room,
  type Vec,
  type Layout,
  type WalkArea,
  type Issue,
  type Region,
} from './model';

export function connectorPoints(
  a: Room,
  b: Room,
  kind: string,
  route: { x: number; z: number }[],
): Vec[] {
  const ac = center(a),
    bc = center(b);
  if (kind === 'spiral') {
    const low = a.floor < b.floor ? ac : bc,
      high = a.floor < b.floor ? bc : ac;
    const pts = Array.from({ length: 65 }, (_, i) => {
      const t = i / 64,
        angle = t * Math.PI * 2;
      return {
        x: low.x + Math.cos(angle) * 1.5,
        y: low.y + t * STOREY,
        z: low.z + Math.sin(angle) * 1.5,
      };
    });
    const all = [
      { x: low.x + 2.4, y: low.y, z: low.z },
      ...pts,
      { x: high.x + 2.4, y: high.y, z: high.z },
    ];
    return a.floor < b.floor ? all : all.reverse();
  }
  if (kind === 'stairs') {
    // Adjacent-grid room centres define an external stair bay across their shared edge.
    const dx = Math.sign(bc.x - ac.x),
      dz = Math.sign(bc.z - ac.z);
    return [
      ac,
      { x: ac.x + dx * 1.2, y: ac.y, z: ac.z + dz * 1.2 },
      { x: bc.x - dx * 1.2, y: bc.y, z: bc.z - dz * 1.2 },
      bc,
    ];
  }
  if (kind === 'corridor') {
    const sa = facing(a, b),
      sb = facing(b, a),
      da = sideDelta[sa],
      db = sideDelta[sb];
    const start = { x: ac.x + da[0] * 3, y: ac.y, z: ac.z + da[1] * 3 },
      end = { x: bc.x + db[0] * 3, y: bc.y, z: bc.z + db[1] * 3 };
    return [ac, start, ...route.map((p) => ({ ...p, y: ac.y })), end, bc];
  }
  if (kind === 'door') {
    const mid = { x: (ac.x + bc.x) / 2, y: ac.y, z: (ac.z + bc.z) / 2 },
      dx = Math.sign(bc.x - ac.x),
      dz = Math.sign(bc.z - ac.z);
    return [
      ac,
      { ...mid, x: mid.x - dx * 0.5, z: mid.z - dz * 0.5 },
      { ...mid, x: mid.x + dx * 0.5, z: mid.z + dz * 0.5 },
      bc,
    ];
  }
  return [ac, bc];
}
const intersect = (a: WalkArea, b: WalkArea, margin = 0) =>
  Math.abs(a.x - b.x) < (a.w + b.w) / 2 - margin &&
  Math.abs(a.z - b.z) < (a.d + b.d) / 2 - margin &&
  Math.abs(a.y - b.y) < 0.1;
export function compile(doc: MuseumDocument): Layout {
  const issues: Issue[] = [],
    walls: Layout['walls'] = [],
    areas: WalkArea[] = doc.rooms.map((r) => ({
      ...center(r),
      w: MODULE,
      d: MODULE,
      roomId: r.id,
    })),
    ramps: Layout['ramps'] = [],
    edges: Layout['edges'] = new Map(doc.rooms.map((r) => [r.id, []]));
  const issue = (code: string, message: string, target: string) =>
    issues.push({ code, message, target });
  const ids = new Set<string>();
  for (const item of [
    ...doc.rooms,
    ...doc.connections,
    ...doc.assets,
    ...doc.regions,
    ...doc.unplaced,
  ]) {
    if (ids.has(item.id)) issue('duplicate', 'Duplicate identifier.', item.id);
    ids.add(item.id);
  }
  for (let i = 0; i < doc.rooms.length; i++)
    for (let j = i + 1; j < doc.rooms.length; j++)
      if (intersect(areas[i], areas[j]))
        issue('overlap', 'Rooms overlap on this floor.', doc.rooms[j].id);
  const roomById = new Map(doc.rooms.map((r) => [r.id, r]));
  const wallsState = new Map<string, 'opening' | 'merged'>(),
    pairs = new Set<string>();
  for (const c of doc.connections) {
    const a = roomById.get(c.a),
      b = roomById.get(c.b);
    if (!a || !b || a.id === b.id) {
      issue('connection', 'Connection needs two different rooms.', c.id);
      continue;
    }
    const pair = [c.a, c.b].sort().join(':');
    if (pairs.has(pair)) {
      issue('connection', 'Only one connection may join a pair of rooms.', c.id);
      continue;
    }
    pairs.add(pair);
    const adjacent = Math.abs(a.x - b.x) + Math.abs(a.z - b.z) === 1,
      vertical = Math.abs(a.floor - b.floor) === 1;
    if (['door', 'closed', 'merged'].includes(c.kind) && (!adjacent || a.floor !== b.floor)) {
      issue('connection', 'Doors and merges require adjacent rooms on the same floor.', c.id);
      continue;
    }
    if (c.kind === 'closed') continue;
    if (c.kind === 'spiral' && (!vertical || a.x !== b.x || a.z !== b.z)) {
      issue('stairs', 'Spiral stairs need vertically aligned rooms on consecutive floors.', c.id);
      continue;
    }
    if (c.kind === 'stairs' && (!vertical || !adjacent)) {
      issue('stairs', 'Stair bays join adjacent grid positions on consecutive floors.', c.id);
      continue;
    }
    if (c.kind === 'corridor' && (a.floor !== b.floor || adjacent)) {
      issue('corridor', 'Corridors join separated rooms on the same floor.', c.id);
      continue;
    }
    const pts = connectorPoints(a, b, c.kind, c.route);
    if (c.kind === 'corridor') {
      const segments: WalkArea[] = [];
      let invalid = false;
      for (let i = 1; i < pts.length; i++) {
        const p = pts[i - 1],
          q = pts[i];
        if (p.x !== q.x && p.z !== q.z) {
          issue('corridor', 'Corridor bends must follow the grid. Add a corner waypoint.', c.id);
          invalid = true;
          break;
        }
        if (i === 1 || i === pts.length - 1) continue;
        const rect = {
          x: (p.x + q.x) / 2,
          z: (p.z + q.z) / 2,
          y: p.y,
          w: Math.max(2, Math.abs(p.x - q.x)),
          d: Math.max(2, Math.abs(p.z - q.z)),
        };
        if (
          areas.some((ar) => ar.roomId !== a.id && ar.roomId !== b.id && intersect(rect, ar, 0.05))
        ) {
          issue('corridor', 'Corridor footprint overlaps another room or corridor.', c.id);
          invalid = true;
        }
        segments.push(rect);
      }
      if (invalid) continue;
      areas.push(...segments);
    }
    if (c.kind === 'stairs' || c.kind === 'spiral') {
      const bottom = Math.min(...pts.map((p) => p.y)),
        top = Math.max(...pts.map((p) => p.y));
      const occupied = ramps.some(
        (r) =>
          Math.max(bottom, Math.min(...r.points.map((p) => p.y))) <
            Math.min(top, Math.max(...r.points.map((p) => p.y))) - 0.05 &&
          r.points.some((p) => pts.some((q) => distance(p, q) < 1.5)),
      );
      if (occupied) {
        issue('stairs', 'Staircase footprints overlap.', c.id);
        continue;
      }
      ramps.push({ id: c.id, points: pts, width: c.kind === 'spiral' ? 0.9 : 1.6, kind: c.kind });
    }
    if (c.kind !== 'spiral')
      for (const [r, other] of [
        [a, b],
        [b, a],
      ]) {
        const key = wallId(r.id, localSide(r, facing(r, other)));
        if (wallsState.has(key)) {
          issue('connection', 'A wall already has a connection.', c.id);
          continue;
        }
        wallsState.set(key, c.kind === 'merged' ? 'merged' : 'opening');
      }
    edges.get(a.id)!.push({ to: b.id, points: pts });
    edges.get(b.id)!.push({ to: a.id, points: [...pts].reverse() });
  }
  for (const r of doc.rooms)
    for (const local of SIDES) {
      const side = physicalSide(r, local),
        key = wallId(r.id, local),
        state = wallsState.get(key);
      if (state === 'merged') continue;
      const [dx, dz] = sideDelta[side],
        c = center(r);
      walls.push({
        id: key,
        roomId: r.id,
        side,
        floor: r.floor,
        center: { x: c.x + dx * 3, y: c.y, z: c.z + dz * 3 },
        length: MODULE,
        opening: state === 'opening',
      });
    }
  if (!roomById.has(doc.entrance)) issue('entrance', 'Choose a visitor entrance.', doc.entrance);
  const reached = new Set<string>(),
    queue = [doc.entrance];
  while (queue.length) {
    const id = queue.shift()!;
    if (reached.has(id)) continue;
    reached.add(id);
    for (const e of edges.get(id) ?? []) queue.push(e.to);
  }
  for (const r of doc.rooms)
    if (!reached.has(r.id))
      issue('unreachable', `${r.name} cannot be reached from the entrance.`, r.id);
  const wallMap = new Map(walls.map((w) => [w.id, w]));
  for (const r of doc.regions) {
    const w = wallMap.get(r.wall);
    if (!w) {
      issue('wall', 'Exhibit wall no longer exists.', r.id);
      continue;
    }
    if (r.x + r.w > 6.001 || r.y + r.h > HEIGHT + 0.001)
      issue('bounds', 'Exhibit region extends past the wall.', r.id);
    if (w.opening && r.x < 4 && r.x + r.w > 2 && r.y < 2.7)
      issue('door', 'Exhibit region overlaps a doorway.', r.id);
    if (r.assetId) {
      const a = doc.assets.find((a) => a.id === r.assetId);
      if (!a || !a.ready) issue('asset', 'Exhibit image has not finished uploading.', r.id);
      if (a && !fitExhibit(r, a.width / a.height, r.frame ?? doc.defaultFrame).fits)
        issue('fit', 'Image, frame, and explanation need more wall space.', r.id);
      if (a && r.plaque !== 'none' && a.explanation.length > 600)
        issue(
          'plaque',
          'Wall explanations are limited to 600 characters. Hide the plaque to keep longer text in the detail view.',
          r.id,
        );
    }
  }
  for (let i = 0; i < doc.regions.length; i++)
    for (let j = i + 1; j < doc.regions.length; j++) {
      const a = doc.regions[i],
        b = doc.regions[j];
      if (
        a.wall === b.wall &&
        a.x < b.x + b.w - 0.001 &&
        a.x + a.w > b.x + 0.001 &&
        a.y < b.y + b.h - 0.001 &&
        a.y + a.h > b.y + 0.001
      )
        issue('region-overlap', 'Wall regions overlap.', b.id);
    }
  for (const r of doc.rooms)
    if (r.kind === 'information') {
      if (!r.pages.length) issue('book', `${r.name} needs at least one book page.`, r.id);
      for (let p = 0; p < r.pages.length; p++)
        if (!bookPageFits(r.pages[p]))
          issue(
            'book',
            `${r.name}, page ${p + 1}: shorten the page to fit the mobile reading size.`,
            r.id,
          );
    }
  if (doc.unplaced.length)
    issue('unplaced', `${doc.unplaced.length} exhibit(s) need placement or removal.`, 'unplaced');
  const holes: WalkArea[] = [];
  for (const c of doc.connections.filter((c) => c.kind === 'spiral' || c.kind === 'stairs')) {
    const a = roomById.get(c.a),
      b = roomById.get(c.b);
    if (!a || !b || !ramps.some((r) => r.id === c.id)) continue;
    const high = a.floor > b.floor ? a : b,
      low = a.floor > b.floor ? b : a,
      p = center(high),
      o = center(low);
    holes.push(
      c.kind === 'spiral'
        ? { ...p, w: 4.2, d: 4.2, roomId: high.id }
        : {
            x: p.x + Math.sign(o.x - p.x) * 1.5,
            z: p.z + Math.sign(o.z - p.z) * 1.5,
            y: p.y,
            w: p.x !== o.x ? 3.1 : 2,
            d: p.z !== o.z ? 3.1 : 2,
            roomId: high.id,
          },
    );
  }
  return { walls, areas, holes, ramps, edges, issues };
}
export function fitExhibit(
  r: Region,
  aspect: number,
  frame: { width: number; mat: number; preset: string },
) {
  const border = (frame.preset === 'none' ? 0 : frame.width) + frame.mat;
  const availableW = r.w - 0.2 - (r.plaque === 'right' ? 0.85 : 0) - border * 2,
    availableH = r.h - 0.2 - (r.plaque === 'below' ? 0.55 : 0) - border * 2;
  const w = Math.max(0.05, Math.min(availableW, availableH * aspect)),
    h = w / aspect;
  return { w, h, border, fits: availableW > 0.2 && availableH > 0.2 && w > 0.15 && h > 0.15 };
}
export function bookPageFits(text: string) {
  return (
    text.length <= 900 &&
    text
      .split('\n')
      .reduce(
        (n, line) => n + Math.max(1, Math.ceil(line.length / 32)) + (line.startsWith('#') ? 1 : 0),
        0,
      ) <= 22
  );
}
export function routeBetween(layout: Layout, from: string, to: string): Vec[] {
  const queue = [from],
    prev = new Map<string, { from: string; points: Vec[] }>(),
    seen = new Set([from]);
  while (queue.length) {
    const id = queue.shift()!;
    if (id === to) break;
    for (const e of layout.edges.get(id) ?? [])
      if (!seen.has(e.to)) {
        seen.add(e.to);
        prev.set(e.to, { from: id, points: e.points });
        queue.push(e.to);
      }
  }
  if (!seen.has(to)) return [];
  const pieces: Vec[][] = [];
  let current = to;
  while (current !== from) {
    const p = prev.get(current)!;
    pieces.unshift(p.points);
    current = p.from;
  }
  return pieces.flat();
}
export function surfaceHeight(layout: Layout, p: Vec, previous: Vec): number | null {
  // Ramp samples are continuous collision surfaces; the visible treads are decorative.
  let rampY: number | null = null,
    best = Infinity;
  for (const ramp of layout.ramps)
    for (let i = 1; i < ramp.points.length; i++) {
      const a = ramp.points[i - 1],
        b = ramp.points[i],
        dx = b.x - a.x,
        dz = b.z - a.z,
        l = dx * dx + dz * dz;
      if (!l) continue;
      const t = Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.z - a.z) * dz) / l)),
        x = a.x + dx * t,
        z = a.z + dz * t,
        y = a.y + (b.y - a.y) * t,
        d = Math.hypot(x - p.x, z - p.z);
      if (d < ramp.width / 2 && Math.abs(y - previous.y) < 0.45 && d < best) {
        best = d;
        rampY = y;
      }
    }
  if (rampY !== null) return rampY;
  for (const hole of layout.holes)
    if (
      Math.abs(hole.y - previous.y) < 0.3 &&
      Math.abs(p.x - hole.x) < hole.w / 2 + 0.13 &&
      Math.abs(p.z - hole.z) < hole.d / 2 + 0.13
    )
      return null;
  for (const wall of layout.walls) {
    if (Math.abs(wall.floor * STOREY - previous.y) > 0.3) continue;
    const horizontal = wall.side === 'north' || wall.side === 'south',
      normal = horizontal ? Math.abs(p.z - wall.center.z) : Math.abs(p.x - wall.center.x),
      along = horizontal ? Math.abs(p.x - wall.center.x) : Math.abs(p.z - wall.center.z);
    if (normal < 0.23 && along < 3.15 && (!wall.opening || along > 0.72)) return null;
  }
  for (const a of layout.areas)
    if (
      Math.abs(p.x - a.x) < a.w / 2 + 0.02 &&
      Math.abs(p.z - a.z) < a.d / 2 + 0.02 &&
      Math.abs(previous.y - a.y) < 0.3
    )
      return a.y;
  return null;
}

/** Route flat interior legs around staircase openings using a tiny visibility graph. */
export function avoidOpenings(layout: Layout, points: Vec[]): Vec[] {
  const output: Vec[] = [];
  for (let i = 0; i < points.length; i++) {
    let end = points[i];
    if (!output.length) {
      for (const hole of layout.holes)
        if (
          Math.abs(hole.y - end.y) < 0.1 &&
          Math.abs(end.x - hole.x) < hole.w / 2 + 0.18 &&
          Math.abs(end.z - hole.z) < hole.d / 2 + 0.18 &&
          surfaceHeight(layout, end, end) === null
        )
          end = { ...end, x: hole.x + hole.w / 2 + 0.3 };
      output.push(end);
      continue;
    }
    const start = output.at(-1)!;
    if (Math.abs(start.y - end.y) > 0.05) {
      output.push(end);
      continue;
    }
    const holes = layout.holes.filter((h) => Math.abs(h.y - start.y) < 0.1);
    if (!holes.length) {
      output.push(end);
      continue;
    }
    const inside = (p: Vec, h: WalkArea) =>
      Math.abs(p.x - h.x) < h.w / 2 + 0.18 && Math.abs(p.z - h.z) < h.d / 2 + 0.18;
    // Central room nodes move to a safe landing outside an upper-floor hole.
    for (const h of holes)
      if (inside(end, h) && surfaceHeight(layout, end, end) === null)
        end = { ...end, x: h.x + h.w / 2 + 0.3 };
    const clear = (a: Vec, b: Vec) => {
      for (let t = 0; t <= 1; t += 1 / Math.max(2, Math.ceil(distance(a, b) / 0.08))) {
        const p = { x: a.x + (b.x - a.x) * t, y: a.y, z: a.z + (b.z - a.z) * t };
        if (surfaceHeight(layout, p, p) === null) return false;
      }
      return true;
    };
    if (clear(start, end)) {
      output.push(end);
      continue;
    }
    const nodes = [
      start,
      end,
      ...holes.flatMap((h) =>
        [-1, 1].flatMap((x) =>
          [-1, 1].map((z) => ({
            x: h.x + x * (h.w / 2 + 0.3),
            y: h.y,
            z: h.z + z * (h.d / 2 + 0.3),
          })),
        ),
      ),
    ];
    const costs = nodes.map(() => Infinity),
      parents = nodes.map(() => -1),
      used = new Set<number>();
    costs[0] = 0;
    for (let n = 0; n < nodes.length; n++) {
      let index = -1;
      for (let j = 0; j < nodes.length; j++)
        if (!used.has(j) && (index < 0 || costs[j] < costs[index])) index = j;
      if (index < 0 || costs[index] === Infinity) break;
      used.add(index);
      for (let j = 0; j < nodes.length; j++)
        if (!used.has(j) && clear(nodes[index], nodes[j])) {
          const cost = costs[index] + distance(nodes[index], nodes[j]);
          if (cost < costs[j]) {
            costs[j] = cost;
            parents[j] = index;
          }
        }
    }
    if (parents[1] !== -1) {
      const leg: Vec[] = [];
      let n = 1;
      while (n > 0) {
        leg.unshift(nodes[n]);
        n = parents[n];
      }
      output.push(...leg);
    } else output.push(end);
  }
  return output;
}

/** Boundary runs of the corridor union, leaving openings where it meets rooms. */
export function corridorBoundaries(layout: Layout) {
  const walls: { x: number; z: number; y: number; w: number; d: number }[] = [];
  for (const area of layout.areas.filter((a) => !a.roomId))
    for (const side of SIDES) {
      const [dx, dz] = sideDelta[side],
        horizontal = dx === 0,
        length = horizontal ? area.w : area.d,
        steps = Math.ceil(length / 0.2),
        step = length / steps;
      let start: number | null = null;
      for (let i = 0; i <= steps; i++) {
        const offset = -length / 2 + (i + 0.5) * step,
          x = area.x + (dx * area.w) / 2 + (horizontal ? offset : 0),
          z = area.z + (dz * area.d) / 2 + (horizontal ? 0 : offset);
        const shared =
          i < steps &&
          layout.areas.some(
            (other) =>
              other !== area &&
              Math.abs(other.y - area.y) < 0.1 &&
              Math.abs(x + dx * 0.05 - other.x) < other.w / 2 - 0.001 &&
              Math.abs(z + dz * 0.05 - other.z) < other.d / 2 - 0.001,
          );
        if (i < steps && !shared && start === null) start = i;
        if ((i === steps || shared) && start !== null) {
          const middle = -length / 2 + ((start + i) * step) / 2;
          walls.push({
            x: area.x + (dx * area.w) / 2 + (horizontal ? middle : 0),
            z: area.z + (dz * area.d) / 2 + (horizontal ? 0 : middle),
            y: area.y,
            w: horizontal ? (i - start) * step : 0.12,
            d: horizontal ? 0.12 : (i - start) * step,
          });
          start = null;
        }
      }
    }
  return walls;
}
