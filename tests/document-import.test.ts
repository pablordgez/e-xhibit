import { expect, it } from 'vitest';
import {
  readMuseumImport,
  validateMuseumImport,
  MAX_IMPORT_FILE_BYTES,
} from '../src/core/documentImport';
import { sample } from '../src/core/sample';

it('accepts existing exports including editable drafts with unplaced artwork', async () => {
  const document = structuredClone(sample);
  document.unplaced.push({ ...document.regions.pop()!, wall: 'removed-room:north' });
  expect(
    await readMuseumImport(new File([JSON.stringify(document, null, 2)], 'museum-backup.json')),
  ).toEqual(document);
});
it('rejects malformed JSON and unsupported schemas', async () => {
  await expect(readMuseumImport(new File(['{broken'], 'backup.json'))).rejects.toThrow(
    'not valid JSON',
  );
  expect(() => validateMuseumImport({ ...sample, schemaVersion: 2 })).toThrow('schema version 1');
});
it('rejects oversized files before reading them', async () => {
  const file = {
    size: MAX_IMPORT_FILE_BYTES + 1,
    text: () => {
      throw Error('Must not read');
    },
  } as unknown as File;
  await expect(readMuseumImport(file)).rejects.toThrow('16 MiB');
});
it('rejects duplicate identifiers and dangling references', () => {
  const duplicate = structuredClone(sample);
  duplicate.rooms.push(structuredClone(duplicate.rooms[0]));
  expect(() => validateMuseumImport(duplicate)).toThrow('duplicate identifiers');
  const dangling = structuredClone(sample);
  dangling.regions[0].assetId = 'missing';
  expect(() => validateMuseumImport(dangling)).toThrow('missing wall or artwork');
});
it.each([
  'https://attacker.test/image.png',
  'javascript:alert(1)',
  'published/old-version/originals/art-1',
  'control/resources.json',
])('rejects unsafe or non-draft image references: %s', (source) => {
  const document = structuredClone(sample);
  document.assets[0].source = source;
  expect(() => validateMuseumImport(document)).toThrow('supported museum image files');
});
it('rejects additional variant keys even when the standard variants are safe', () => {
  const document = structuredClone(sample);
  document.assets[0].variants.extra = 'https://attacker.test/image';
  expect(() => validateMuseumImport(document)).toThrow('supported museum image files');
});
