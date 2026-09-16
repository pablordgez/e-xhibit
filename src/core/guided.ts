import { avoidOpenings, navigationStops, routeBetween, surfaceHeight } from './layout';
import { center, distance, type Layout, type MuseumDocument, type Vec } from './model';

export type GuidedStop = Vec & {
  roomId: string;
  label: string;
  rooms?: string[];
  route?: Vec[];
  index?: number;
  stairs?: 'up' | 'down';
  inCorridor?: boolean;
};

/** Viewing positions plus spaced waypoints through doors, bends and stair entries. */
export function guidedStops(doc: MuseumDocument, layout: Layout): GuidedStop[] {
  const stops: GuidedStop[] = navigationStops(doc, layout);
  for (const link of doc.connections) {
    const edge = layout.edges.get(link.a)?.find((e) => e.to === link.b);
    if (!edge) continue;
    const safePoints = avoidOpenings(layout, edge.points);
    if (!safePoints.length) continue;
    const rooms = [link.a, link.b];
    if (link.kind === 'stairs' || link.kind === 'spiral') {
      for (const [source, target, route] of [
        [link.a, link.b, safePoints],
        [link.b, link.a, [...safePoints].reverse()],
      ] as const) {
        // A local, visible floor control starts the whole stair journey. No
        // need to see or click a different floor through the ceiling.
        const start = route[0],
          next = route[1];
        const p =
          link.kind === 'spiral'
            ? {
                ...start,
                x: start.x - 0.12,
                z: start.z + (start.y < route.at(-1)!.y ? 0.38 : -0.38),
              }
            : {
                ...next,
                x: next.x + Math.sign(start.x - next.x) * 0.65,
                z: next.z + Math.sign(start.z - next.z) * 0.65,
              };
        stops.push({
          ...p,
          roomId: target,
          label: start.y < route.at(-1)!.y ? 'Go upstairs' : 'Go downstairs',
          stairs: start.y < route.at(-1)!.y ? 'up' : 'down',
          rooms: [source],
          route: [...route],
          index: route.length - 1,
        });
      }
      continue;
    }
    // Subdivide flat routes, retaining all corners. Resampling the compiler's
    // safe paths makes a corridor navigable even when its far room is hidden.
    const route: Vec[] = [safePoints[0]];
    for (let i = 1; i < safePoints.length; i++) {
      const a = safePoints[i - 1],
        b = safePoints[i];
      const count = Math.max(1, Math.ceil(distance(a, b) / 2));
      for (let n = 1; n <= count; n++) {
        const t = n / count;
        route.push({
          x: a.x + (b.x - a.x) * t,
          y: a.y + (b.y - a.y) * t,
          z: a.z + (b.z - a.z) * t,
        });
      }
    }
    for (let index = 0; index < route.length; index++) {
      const p = route[index];
      if (stops.some((s) => !s.stairs && distance(s, p) < 1.25)) continue;
      const room = doc.rooms.find((r) => {
        const c = center(r);
        return Math.abs(c.y - p.y) < 0.1 && Math.abs(c.x - p.x) < 3 && Math.abs(c.z - p.z) < 3;
      });
      stops.push({
        ...p,
        roomId: room?.id ?? link.a,
        label: room?.name ?? 'Continue along corridor',
        rooms,
        route,
        index,
        inCorridor: !room,
      });
    }
  }
  return stops.filter(
    (s) => s.stairs || !stops.some((other) => other.stairs && distance(other, s) < 0.9),
  );
}

/** Join a route at the visitor's actual progress, including travel backwards. */
export function pathToGuidedStop(layout: Layout, body: Vec, room: string, stop: GuidedStop) {
  if (!stop.stairs && flatPathClear(layout, body, stop)) return [body, stop];
  if (!stop.route)
    return simplifyGuidedPath(
      layout,
      avoidOpenings(layout, [body, ...routeBetween(layout, room, stop.roomId), stop]),
    );
  const route = stop.route;
  let closest = 0,
    best = Infinity,
    projection = route[0];
  for (let i = 1; i < route.length; i++) {
    const a = route[i - 1],
      b = route[i],
      length = distance(a, b) ** 2;
    const t = length
      ? Math.max(
          0,
          Math.min(
            1,
            ((body.x - a.x) * (b.x - a.x) +
              (body.y - a.y) * (b.y - a.y) +
              (body.z - a.z) * (b.z - a.z)) /
              length,
          ),
        )
      : 0;
    const p = { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t, z: a.z + (b.z - a.z) * t };
    const d = distance(body, p);
    if (d < best) {
      best = d;
      closest = i - 1 + t;
      projection = p;
    }
  }
  const index = stop.index!;
  const legs =
    closest <= index
      ? route.slice(Math.floor(closest) + 1, index + 1)
      : route.slice(index, Math.ceil(closest)).reverse();
  return simplifyGuidedPath(layout, avoidOpenings(layout, [body, projection, ...legs]));
}

export function flatPathClear(layout: Layout, a: Vec, b: Vec) {
  if (Math.abs(a.y - b.y) > 0.001) return false;
  const count = Math.max(1, Math.ceil(distance(a, b) / 0.05));
  for (let i = 0; i <= count; i++) {
    const t = i / count;
    const p = { x: a.x + (b.x - a.x) * t, y: a.y, z: a.z + (b.z - a.z) * t };
    const height = surfaceHeight(layout, p, p);
    if (height === null || Math.abs(height - p.y) > 0.05) return false;
  }
  return true;
}

/** Remove duplicate points and detours only across genuinely walkable flat floor. */
export function simplifyGuidedPath(layout: Layout, points: Vec[]) {
  const result: Vec[] = [];
  let i = 0;
  while (i < points.length) {
    const start = points[i];
    if (!result.length || distance(result.at(-1)!, start) > 0.001) result.push(start);
    let next = i + 1;
    for (let j = i + 2; j < points.length; j++) {
      if (points.slice(i, j + 1).some((p) => Math.abs(p.y - start.y) > 0.001)) break;
      if (flatPathClear(layout, start, points[j])) next = j;
    }
    i = next;
  }
  return result;
}
