import { museumSchema, SIDES, type MuseumDocument } from './model';
import { sample } from './sample';

export const MAX_IMPORT_FILE_BYTES = 16 * 1024 * 1024;

/** Validate an untrusted export before it can replace or render the current draft. */
export function validateMuseumImport(value: unknown): MuseumDocument {
  const parsed = museumSchema.safeParse(value);
  if (!parsed.success)
    throw Error(
      'This is not a supported museum document. Choose an exported schema version 1 JSON file.',
    );
  const document = parsed.data;
  if (
    new TextEncoder().encode(JSON.stringify({ document, revision: Number.MAX_SAFE_INTEGER }))
      .length >
    8 * 1024 * 1024
  )
    throw Error(
      'The museum document is too large to save. Image files must be backed up separately.',
    );
  const ids = new Set<string>();
  for (const item of [
    ...document.rooms,
    ...document.connections,
    ...document.assets,
    ...document.regions,
    ...document.unplaced,
  ]) {
    if (ids.has(item.id)) throw Error('The museum document contains duplicate identifiers.');
    ids.add(item.id);
  }
  const rooms = new Set(document.rooms.map((room) => room.id));
  const assets = new Set(document.assets.map((asset) => asset.id));
  if (
    !rooms.has(document.entrance) ||
    document.connections.some((c) => !rooms.has(c.a) || !rooms.has(c.b))
  )
    throw Error('The museum document references a missing room.');
  const walls = new Set(
    document.rooms.flatMap((room) => SIDES.map((side) => `${room.id}:${side}`)),
  );
  if (
    document.regions.some((region) => !walls.has(region.wall)) ||
    [...document.regions, ...document.unplaced].some(
      (region) => region.assetId && !assets.has(region.assetId),
    ) ||
    document.rooms.some((room) => room.shelves.some((id) => !assets.has(id)))
  )
    throw Error('The museum document references a missing wall or artwork.');
  const builtins = new Map(sample.assets.map((asset) => [asset.id, asset]));
  for (const asset of document.assets) {
    const builtin = builtins.get(asset.id);
    const expected =
      builtin?.variants ??
      Object.fromEntries(
        ['512', '1024', '2048'].map((size) => [size, `variants/${asset.id}/${size}`]),
      );
    const validId =
      builtin ||
      /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(asset.id);
    if (
      !validId ||
      !asset.ready ||
      asset.source !== (builtin?.source ?? `originals/${asset.id}`) ||
      Object.keys(asset.variants).length !== Object.keys(expected).length ||
      Object.entries(expected).some(([size, key]) => asset.variants[size] !== key) ||
      (builtin && (asset.width !== builtin.width || asset.height !== builtin.height))
    )
      throw Error(
        `Artwork “${asset.title}” does not reference supported museum image files. Use a draft export from this installation.`,
      );
  }
  return document;
}

export async function readMuseumImport(file: File): Promise<MuseumDocument> {
  if (file.size > MAX_IMPORT_FILE_BYTES)
    throw Error('Museum document files must be no larger than 16 MiB.');
  let value: unknown;
  try {
    value = JSON.parse(await file.text());
  } catch {
    throw Error('The selected file is not valid JSON. Choose an exported museum document.');
  }
  return validateMuseumImport(value);
}
