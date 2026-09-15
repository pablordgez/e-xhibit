import { type MuseumDocument } from './model';
/** Only content actually used in a publication crosses the private/public boundary. */
export function publicDocument(draft: MuseumDocument): MuseumDocument {
  const ids = new Set(draft.regions.map((r) => r.assetId).filter(Boolean));
  return {
    ...structuredClone(draft),
    assets: draft.assets.filter((a) => ids.has(a.id)).map((a) => structuredClone(a)),
    rooms: draft.rooms.map((r) => ({
      ...r,
      pages: r.kind === 'information' ? [...r.pages] : [],
      shelves: r.kind === 'shop' ? r.shelves.filter((id) => ids.has(id)) : [],
    })),
    unplaced: [],
  };
}
