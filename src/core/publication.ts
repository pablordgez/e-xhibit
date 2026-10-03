import { type MuseumDocument } from './model';
/** Only content actually used in a publication crosses the private/public boundary. */
export function publicDocument(draft: MuseumDocument): MuseumDocument {
  const ids = new Set(draft.regions.map((r) => r.assetId).filter(Boolean));
  const assets = draft.assets.filter((a) => ids.has(a.id)).map((a) => structuredClone(a));
  const categories = new Set(assets.flatMap((a) => a.categoryIds ?? []));
  return {
    ...structuredClone(draft),
    assets,
    ...(draft.categories
      ? { categories: draft.categories.filter((c) => categories.has(c.id)).map((c) => ({ ...c })) }
      : {}),
    rooms: draft.rooms.map((r) => ({
      ...r,
      pages: r.kind === 'information' ? [...r.pages] : [],
      shelves: r.kind === 'shop' ? r.shelves.filter((id) => ids.has(id)) : [],
    })),
    unplaced: [],
  };
}
