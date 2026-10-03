import {
  stairArchitecture,
  contains,
  spiralObstructs,
  spiralWalkingHeight,
  spiralGeometry,
  SPIRAL_RADIUS,
} from './architecture';
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
  type Furnishing,
} from './model';
import { fitExhibit } from './exhibits';
export { fitExhibit } from './exhibits';

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
      { x: high.x + 1.5, y: high.y, z: high.z + 0.8 },
      { x: high.x + 2.4, y: high.y, z: high.z + 0.8 },
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
      const footprintBlocked = areas.some((area) => {
        if (area.roomId === a.id || area.roomId === b.id || area.y < bottom || area.y > top)
          return false;
        return pts.slice(1).some((p, i) => {
          const q = pts[i];
          const width = c.kind === 'spiral' ? 0.9 : 1.6;
          return intersect(
            area,
            {
              x: (p.x + q.x) / 2,
              z: (p.z + q.z) / 2,
              y: area.y,
              w: Math.abs(p.x - q.x) + width,
              d: Math.abs(p.z - q.z) + width,
            },
            0.05,
          );
        });
      });
      if (footprintBlocked) {
        issue(
          'stairs',
          'This staircase needs clear space on both floors. Another room or corridor occupies its footprint.',
          c.id,
        );
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
      if (a && !fitExhibit(r, a.width / a.height, r.frame ?? doc.defaultFrame, a).fits)
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
  const { holes, ceilingHoles, structures } = stairArchitecture(doc, ramps);
  const furnishings: Furnishing[] = [];
  // Reserve doors, stair flights and landings before furnishing a room. These
  // footprints are shared by rendering, walking and guided navigation.
  const reserved: WalkArea[] = [
    ...holes,
    ...walls
      .filter((w) => w.opening)
      .map((w) => {
        const [dx, dz] = sideDelta[w.side];
        return {
          x: w.center.x - dx * 0.7,
          z: w.center.z - dz * 0.7,
          y: w.center.y,
          w: dx ? 1.8 : 2.2,
          d: dz ? 1.8 : 2.2,
        };
      }),
  ];
  for (const ramp of ramps) {
    const levels = new Set(ramp.points.map((p) => Math.round(p.y / STOREY) * STOREY));
    for (const y of levels)
      for (let i = 1; i < ramp.points.length; i++) {
        const a = ramp.points[i - 1],
          b = ramp.points[i];
        reserved.push({
          x: (a.x + b.x) / 2,
          z: (a.z + b.z) / 2,
          y,
          w: Math.abs(a.x - b.x) + ramp.width,
          d: Math.abs(a.z - b.z) + ramp.width,
        });
      }
  }
  for (const room of doc.rooms.filter((r) => r.kind !== 'gallery')) {
    const p = center(room);
    const fits = (f: Furnishing) =>
      ![...reserved, ...furnishings].some((r) => intersect(f, r, -0.12));
    // A real counter or kiosk in ordinary rooms; compact wall units in stair rooms.
    const stands = [0, 1, 2, 3].map((i): Furnishing => {
      const angle = ((i + room.rotation) * Math.PI) / 2;
      return {
        x:
          p.x +
          Math.cos(angle) * (room.kind === 'information' ? 1.9 : 2.3) +
          Math.sin(angle) * 2.25,
        z:
          p.z -
          Math.sin(angle) * (room.kind === 'information' ? 1.9 : 2.3) +
          Math.cos(angle) * 2.25,
        y: p.y,
        w:
          (i + room.rotation) % 2
            ? room.kind === 'information'
              ? 0.9
              : 0.6
            : room.kind === 'information'
              ? 1.4
              : 0.7,
        d:
          (i + room.rotation) % 2
            ? room.kind === 'information'
              ? 1.4
              : 0.7
            : room.kind === 'information'
              ? 0.9
              : 0.6,
        kind: 'stand',
        roomId: room.id,
        rotation: angle,
      };
    });
    const spiralRoom = doc.connections.some(
      (c) => c.kind === 'spiral' && (c.a === room.id || c.b === room.id),
    );
    const wallStands = walls
      .filter((w) => w.roomId === room.id)
      .sort((a, b) => (spiralRoom ? Number(b.side === 'east') - Number(a.side === 'east') : 0))
      .flatMap((wall) => {
        const [dx, dz] = sideDelta[wall.side];
        return [-1.4, 1.4, 0].map((along): Furnishing => ({
          x: p.x + dx * 2.78 + (dz ? along : 0),
          z: p.z + dz * 2.78 + (dx ? along : 0),
          y: p.y,
          w: dx ? 0.2 : 0.65,
          d: dz ? 0.2 : 0.65,
          mounted: true,
          roomId: room.id,
          kind: 'stand',
          rotation: Math.atan2(dx, dz),
        }));
      });
    // A spiral leaves a narrow circulation ring: use a wall-mounted information
    // point instead of a floor pedestal that would pinch off a corner.
    const stand = (spiralRoom ? wallStands : [...stands, ...wallStands]).find(fits);
    if (stand) furnishings.push(stand);
    else
      issue(
        'furnishing',
        `${room.name} has no safe space for its ${room.kind === 'shop' ? 'kiosk' : 'information stand'}. Keep a corner clear of stairs and entrances.`,
        room.id,
      );
    if (room.kind !== 'shop') continue;
    const candidates = walls
      .filter((w) => w.roomId === room.id && !doc.regions.some((r) => r.wall === w.id && r.assetId))
      .flatMap((wall) => {
        const [dx, dz] = sideDelta[wall.side];
        return [-1.8, 1.8, 0].map((along): Furnishing => ({
          x: p.x + dx * 2.78 + (dz ? along : 0),
          z: p.z + dz * 2.78 + (dx ? along : 0),
          y: p.y,
          w: dx ? 0.2 : 1.4,
          d: dz ? 0.2 : 1.4,
          roomId: room.id,
          kind: 'shelf',
          wall: wall.id,
          rotation: Math.atan2(dx, dz),
        }));
      });
    let shelfCount = 0;
    const shelfWalls = new Set<string>();
    for (const spread of [true, false])
      for (const shelf of candidates) {
        if (shelfCount >= (spiralRoom ? 2 : 3)) break;
        if (spread && shelfWalls.has(shelf.wall!)) continue;
        if (fits(shelf)) {
          furnishings.push(shelf);
          shelfWalls.add(shelf.wall!);
          shelfCount++;
        }
      }
    if (!shelfCount)
      issue(
        'furnishing',
        `${room.name} has no safe wall space for its shelves. Use a gallery here or keep a wall section clear of stairs and entrances.`,
        room.id,
      );
    // Keep the central viewing position and door approaches open. Freestanding
    // displays enrich ordinary shops; optional pieces never crowd stair rooms.
    if (!spiralRoom) {
      const corners = [
        [-1.8, 1.8],
        [1.8, 1.8],
        [-1.8, -1.8],
        [1.8, -1.8],
      ];
      const table = corners
        .map(([x, z]): Furnishing => ({
          x: p.x + x,
          z: p.z + z,
          y: p.y,
          w: 1.1,
          d: 0.85,
          kind: 'table',
          roomId: room.id,
          rotation: 0,
        }))
        .find(fits);
      if (table) furnishings.push(table);
      const plant = [
        ...corners.map(([x, z]) => [x * 1.4, z * 1.4]),
        [-2.3, 0],
        [2.3, 0],
        [0, -2.3],
        [0, 2.3],
      ]
        .map(([x, z]): Furnishing => ({
          x: p.x + x,
          z: p.z + z,
          y: p.y,
          w: 0.42,
          d: 0.42,
          kind: 'plant',
          roomId: room.id,
          rotation: 0,
        }))
        .find(fits);
      if (plant) furnishings.push(plant);
    }
  }
  const stairClearances = doc.connections
    .filter((c) => c.kind === 'spiral' && ramps.some((r) => r.id === c.id))
    .map((c) => {
      const a = roomById.get(c.a)!,
        b = roomById.get(c.b)!;
      const low = a.floor < b.floor ? a : b;
      return { ...center(low), w: 4.1, d: 4.1, roomId: low.id, shape: 'circle' as const };
    });
  const layout = {
    walls,
    areas,
    holes,
    ceilingHoles,
    structures,
    stairClearances,
    ramps,
    edges,
    furnishings,
    issues,
  };
  const destinations = new Map(navigationStops(doc, layout).map((p) => [p.roomId, p]));
  // Room routes must start and end at viewing positions, never at the pole of a spiral.
  for (const [id, links] of edges)
    for (const link of links) {
      const source = destinations.get(id),
        target = destinations.get(link.to);
      if (source) link.points[0] = source;
      if (target) link.points[link.points.length - 1] = target;
    }
  for (const room of doc.rooms)
    if (!destinations.has(room.id))
      issue('clearance', `${room.name} has no clear viewing position or stair landing.`, room.id);
  for (const [id, links] of edges)
    for (const link of links) {
      if (id > link.to) continue;
      if (!avoidOpenings(layout, link.points).length) {
        const connection = doc.connections.find(
          (c) => [c.a, c.b].includes(id) && [c.a, c.b].includes(link.to),
        );
        issue(
          'clearance',
          `Keep a clear path between ${roomById.get(id)!.name} and ${roomById.get(link.to)!.name}. The stairs or furnishings leave too little walking space.`,
          connection?.id ?? id,
        );
      }
    }
  return layout;
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
  for (const f of layout.furnishings)
    if (
      Math.abs(previous.y - f.y) < 2.1 &&
      Math.abs(p.x - f.x) < f.w / 2 + 0.23 &&
      Math.abs(p.z - f.z) < f.d / 2 + 0.23
    )
      return null;
  for (const solid of layout.structures)
    if (previous.y + 1.8 > solid.y && previous.y < solid.y + solid.h && contains(solid, p, 0.16))
      return null;
  // Ramp samples are continuous collision surfaces; the visible treads are decorative.
  let rampY: number | null = null,
    best = Infinity;
  for (const ramp of layout.ramps) {
    if (ramp.kind === 'spiral') {
      const height = spiralWalkingHeight(ramp, p, previous);
      if (height !== null) return height;
      continue;
    }
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
  }
  if (rampY !== null) return rampY;
  for (const hole of layout.holes)
    if (Math.abs(hole.y - previous.y) < 0.3 && contains(hole, p, 0.13)) return null;
  for (const shaft of layout.stairClearances)
    if (Math.abs(shaft.y - previous.y) < 0.3 && spiralObstructs(shaft, p)) return null;
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
      for (const hole of [...layout.holes, ...layout.stairClearances])
        if (
          Math.abs(hole.y - end.y) < 0.1 &&
          contains(hole, end, 0.18) &&
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
    const holes = [...layout.holes, ...layout.stairClearances, ...layout.furnishings].filter(
      (h) => Math.abs(h.y - start.y) < 0.1,
    );
    if (!holes.length) {
      output.push(end);
      continue;
    }
    const inside = (p: Vec, h: WalkArea) => contains(h, p, 0.18);
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
        h.shape === 'circle'
          ? Array.from({ length: 12 }, (_, i) => ({
              x: h.x + Math.cos((i * Math.PI) / 6) * (h.w / 2 + 0.3),
              y: h.y,
              z: h.z + Math.sin((i * Math.PI) / 6) * (h.d / 2 + 0.3),
            }))
          : [-1, 1].flatMap((x) =>
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
    } else return []; // Never animate through an obstruction when a route is unavailable.
  }
  return output;
}

/** Apply both axes to the latest position, sliding along walls without losing an axis. */
export function walkStep(
  layout: Layout,
  position: Vec,
  yaw: number,
  forward: number,
  right: number,
  seconds: number,
): Vec {
  const length = Math.hypot(forward, right);
  if (!length) return position;
  const scale = (seconds * 2.4) / length;
  const dx = (Math.sin(yaw) * forward + Math.cos(yaw) * right) * scale;
  const dz = (Math.cos(yaw) * forward - Math.sin(yaw) * right) * scale;
  let body = { ...position };
  const steps = Math.max(1, Math.ceil(Math.hypot(dx, dz) / 0.06));
  for (let i = 0; i < steps; i++) {
    const desired = { ...body, x: body.x + dx / steps, z: body.z + dz / steps };
    const height = surfaceHeight(layout, desired, body);
    if (height !== null) {
      body = { ...desired, y: height };
      continue;
    }
    // Slide along the curved tread edges instead of snagging when the visitor
    // drifts slightly outward while steering around the spiral.
    let slidOnStair = false;
    for (const ramp of layout.ramps.filter((r) => r.kind === 'spiral')) {
      const g = spiralGeometry(ramp);
      if (body.y <= g.bottom + 0.1 || body.y >= g.top - 0.1) continue;
      const radius = Math.hypot(desired.x - g.x, desired.z - g.z);
      const clamped = Math.max(0.39, Math.min(SPIRAL_RADIUS - 0.135, radius));
      if (Math.abs(clamped - radius) > 0.07) continue;
      const p = {
        x: g.x + ((desired.x - g.x) / radius) * clamped,
        z: g.z + ((desired.z - g.z) / radius) * clamped,
        y: body.y,
      };
      const y = surfaceHeight(layout, p, body);
      if (y !== null) {
        body = { ...p, y };
        slidOnStair = true;
        break;
      }
    }
    if (slidOnStair) continue;
    // Slide around the actual round shaft instead of snagging on an invisible
    // square or dropping an entire movement axis at its edge.
    const circle = [...layout.holes, ...layout.stairClearances].find(
      (h) => h.shape === 'circle' && Math.abs(h.y - body.y) < 0.3 && contains(h, desired, 0.13),
    );
    if (circle) {
      const radius = circle.w / 2 + 0.135,
        angle = Math.atan2(desired.z - circle.z, desired.x - circle.x);
      const slid = {
        x: circle.x + Math.cos(angle) * radius,
        y: body.y,
        z: circle.z + Math.sin(angle) * radius,
      };
      const y = surfaceHeight(layout, slid, body);
      if (y !== null && distance(slid, body) < 0.09) {
        body = { ...slid, y };
        continue;
      }
    }
    for (const axis of ['x', 'z'] as const) {
      const next = { ...body, [axis]: body[axis] + (axis === 'x' ? dx : dz) / steps };
      const y = surfaceHeight(layout, next, body);
      if (y !== null) body = { ...next, y };
    }
  }
  return body;
}

/** One deliberate viewing position per module; spiral rooms use their outer landing. */
export function navigationStops(doc: MuseumDocument, layout: Layout) {
  const stops: (Vec & { roomId: string; label: string })[] = [];
  for (const room of doc.rooms) {
    const c = center(room);
    const spiral = doc.connections.some(
      (link) =>
        link.kind === 'spiral' &&
        (link.a === room.id || link.b === room.id) &&
        layout.ramps.some((r) => r.id === link.id),
    );
    const candidates = spiral
      ? [[2.4, 0]]
      : [
          [0, 0],
          [0, 1],
          [0, -1],
          [1, 0],
          [-1, 0],
        ];
    for (const [x, z] of candidates) {
      const p = { x: c.x + x, y: c.y, z: c.z + z };
      const height = surfaceHeight(layout, p, p);
      if (height !== null && Math.abs(height - p.y) < 0.02) {
        stops.push({ ...p, roomId: room.id, label: spiral ? 'Stair landing' : room.name });
        break;
      }
    }
  }
  return stops;
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
