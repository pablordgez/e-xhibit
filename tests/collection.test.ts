import { expect, it } from 'vitest';
import { sample } from '../src/core/sample';
import { museumSchema } from '../src/core/model';
import { filterArtwork, saveCategory, removeCategory } from '../src/core/collection';

it('loads older museums and preserves category metadata through document validation', () => {
  const legacy = museumSchema.parse(sample);
  expect(legacy.categories).toBeUndefined();
  const categorized = saveCategory(legacy, ' Landscapes ');
  categorized.assets[0] = {
    ...categorized.assets[0],
    categoryIds: [categorized.categories![0].id],
  };
  const restored = museumSchema.parse(JSON.parse(JSON.stringify(categorized)));
  expect(restored.categories![0].name).toBe('Landscapes');
  expect(restored.assets[0].categoryIds).toEqual([restored.categories![0].id]);
});

it('combines search with categories and removes category assignments without losing artwork', () => {
  let doc = saveCategory(structuredClone(sample), 'Landscapes');
  const id = doc.categories![0].id;
  doc.assets[0].categoryIds = [id];
  expect(() => saveCategory(doc, ' landscapes ')).toThrow('already exists');
  expect(filterArtwork(doc, 'PALE HILLS', id).map((a) => a.id)).toEqual(['art-1']);
  expect(filterArtwork(doc, 'landscapes', '').map((a) => a.id)).toEqual(['art-1']);
  expect(filterArtwork(doc, '', 'uncategorized')).toHaveLength(doc.assets.length - 1);
  doc = saveCategory(doc, 'Outdoor works', id);
  expect(filterArtwork(doc, 'outdoor', id)).toHaveLength(1);
  const removed = removeCategory(doc, id);
  expect(removed.categories).toEqual([]);
  expect(removed.assets).toHaveLength(doc.assets.length);
  expect(removed.regions).toEqual(doc.regions);
  expect(filterArtwork(removed, '', 'uncategorized')).toHaveLength(doc.assets.length);
});
