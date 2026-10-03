import { type MuseumDocument, type Asset, uid } from './model';

export function filterArtwork(doc: MuseumDocument, search: string, category: string): Asset[] {
  const query = search.trim().toLocaleLowerCase();
  return doc.assets.filter((asset) => {
    const ids = asset.categoryIds ?? [];
    const matchesCategory =
      !category || (category === 'uncategorized' ? !ids.length : ids.includes(category));
    const text = [
      asset.title,
      asset.attribution,
      asset.explanation,
      ...(doc.categories ?? []).filter((c) => ids.includes(c.id)).map((c) => c.name),
    ]
      .join(' ')
      .toLocaleLowerCase();
    return matchesCategory && (!query || text.includes(query));
  });
}

export function saveCategory(doc: MuseumDocument, name: string, id?: string): MuseumDocument {
  const trimmed = name.trim();
  if (!trimmed || trimmed.length > 80)
    throw Error('Use a category name between 1 and 80 characters.');
  const categories = doc.categories ?? [];
  if (
    categories.some(
      (c) => c.id !== id && c.name.toLocaleLowerCase() === trimmed.toLocaleLowerCase(),
    )
  )
    throw Error('A category with this name already exists.');
  if (!id && categories.length >= 100) throw Error('You can create up to 100 categories.');
  return {
    ...doc,
    categories: id
      ? categories.map((c) => (c.id === id ? { ...c, name: trimmed } : c))
      : [...categories, { id: uid(), name: trimmed }],
  };
}

export function removeCategory(doc: MuseumDocument, id: string): MuseumDocument {
  return {
    ...doc,
    categories: (doc.categories ?? []).filter((c) => c.id !== id),
    assets: doc.assets.map((a) =>
      a.categoryIds?.includes(id)
        ? { ...a, categoryIds: a.categoryIds.filter((category) => category !== id) }
        : a,
    ),
  };
}
