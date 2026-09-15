import { compile } from './layout';
import { uid, wallId, type MuseumDocument, type Room, type Region, type Side } from './model';
const constructionCodes = new Set([
  'overlap',
  'connection',
  'stairs',
  'corridor',
  'furnishing',
  'clearance',
]);
/** Structural edits must be safe before they enter the draft/undo history. */
export function constructionProblems(before: MuseumDocument, after: MuseumDocument) {
  const old = new Set(compile(before).issues.map((i) => `${i.code}:${i.target}:${i.message}`));
  return compile(after).issues.filter(
    (i) => constructionCodes.has(i.code) && !old.has(`${i.code}:${i.target}:${i.message}`),
  );
}
export function reconcile(doc: MuseumDocument): MuseumDocument {
  const layout = compile(doc),
    valid = new Map(layout.walls.map((w) => [w.id, w]));
  const lost = doc.regions.filter((r) => {
    const w = valid.get(r.wall);
    return !w || (w.opening && r.x < 4 && r.x + r.w > 2 && r.y < 2.7);
  });
  return {
    ...doc,
    regions: doc.regions.filter((r) => !lost.includes(r)),
    unplaced: [...doc.unplaced, ...lost.filter((r) => r.assetId)],
  };
}
export function addRoom(doc: MuseumDocument, room: Room): MuseumDocument {
  const connections = [...doc.connections];
  for (const r of doc.rooms)
    if (r.floor === room.floor && Math.abs(r.x - room.x) + Math.abs(r.z - room.z) === 1)
      connections.push({ id: uid(), a: r.id, b: room.id, kind: 'door', route: [] });
  return reconcile({ ...doc, rooms: [...doc.rooms, room], connections });
}
export function deleteRoom(doc: MuseumDocument, id: string) {
  if (doc.rooms.length === 1) return doc;
  return reconcile({
    ...doc,
    rooms: doc.rooms.filter((r) => r.id !== id),
    connections: doc.connections.filter((c) => c.a !== id && c.b !== id),
    entrance: doc.entrance === id ? doc.rooms.find((r) => r.id !== id)!.id : doc.entrance,
  });
}
export function initializeWall(doc: MuseumDocument, room: string, side: Side): MuseumDocument {
  const wall = wallId(room, side);
  if (doc.regions.some((r) => r.wall === wall)) return doc;
  const w = compile(doc).walls.find((w) => w.id === wall);
  if (!w) return doc;
  const make = (x: number, width: number): Region => ({
    id: uid(),
    wall,
    x,
    y: 0.35,
    w: width,
    h: 2.95,
    plaque: 'below',
  });
  return {
    ...doc,
    regions: [
      ...doc.regions,
      ...(w.opening ? [make(0.15, 1.7), make(4.15, 1.7)] : [make(0.25, 5.5)]),
    ],
  };
}
export function splitRegion(doc: MuseumDocument, id: string, axis: 'x' | 'y', ratio = 0.5) {
  const r = doc.regions.find((r) => r.id === id);
  if (!r) return doc;
  ratio = Math.max(0.2, Math.min(0.8, ratio));
  const size = axis === 'x' ? 'w' : 'h';
  const a = { ...r, [size]: r[size] * ratio },
    b = {
      ...r,
      id: uid(),
      assetId: undefined,
      [axis]: r[axis] + r[size] * ratio,
      [size]: r[size] * (1 - ratio),
    };
  return {
    ...doc,
    regions: doc.regions.flatMap((region) => (region.id === id ? [a, b] : [region])),
  };
}
export function mergeRegions(doc: MuseumDocument, ids: string[]) {
  const regions = doc.regions.filter((r) => ids.includes(r.id));
  if (regions.length < 2 || regions.some((r) => r.wall !== regions[0].wall))
    throw Error('Choose adjacent regions on one wall.');
  const x = Math.min(...regions.map((r) => r.x)),
    y = Math.min(...regions.map((r) => r.y)),
    w = Math.max(...regions.map((r) => r.x + r.w)) - x,
    h = Math.max(...regions.map((r) => r.y + r.h)) - y;
  if (Math.abs(regions.reduce((sum, r) => sum + r.w * r.h, 0) - w * h) > 0.005)
    throw Error('Selected regions must form a rectangle.');
  const occupied = regions.filter((r) => r.assetId);
  if (occupied.length > 1) throw Error('Move all but one image out of the regions before merging.');
  const merged = { ...(occupied[0] ?? regions[0]), x, y, w, h };
  return { ...doc, regions: [...doc.regions.filter((r) => !ids.includes(r.id)), merged] };
}
export function resizeRegion(doc: MuseumDocument, id: string, axis: 'w' | 'h', value: number) {
  const r = doc.regions.find((r) => r.id === id);
  if (!r) return doc;
  const pos = axis === 'w' ? 'x' : 'y',
    otherPos = axis === 'w' ? 'y' : 'x',
    otherSize = axis === 'w' ? 'h' : 'w',
    delta = value - r[axis],
    edge = r[pos] + r[axis];
  if (value < 0.2 || r[pos] + value > (axis === 'w' ? 6 : 3.8))
    throw Error('Keep regions within the wall and at least 20 cm wide/high.');
  const neighbors = doc.regions.filter(
    (n) =>
      n.wall === r.wall &&
      n.id !== id &&
      Math.abs(n[pos] - edge) < 0.001 &&
      n[otherPos] < r[otherPos] + r[otherSize] - 0.001 &&
      n[otherPos] + n[otherSize] > r[otherPos] + 0.001,
  );
  if (
    neighbors.some(
      (n) =>
        n[otherPos] < r[otherPos] - 0.001 ||
        n[otherPos] + n[otherSize] > r[otherPos] + r[otherSize] + 0.001 ||
        n[axis] - delta < 0.2,
    )
  )
    throw Error('This divider cannot move that far. Split or merge the neighboring region first.');
  return {
    ...doc,
    regions: doc.regions.map((n) =>
      n.id === id
        ? { ...n, [axis]: value }
        : neighbors.includes(n)
          ? { ...n, [pos]: n[pos] + delta, [axis]: n[axis] - delta }
          : n,
    ),
  };
}
