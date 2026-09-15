import { it, expect } from 'vitest';
import { sample } from '../src/core/sample';
import { compile } from '../src/core/layout';
import { defaultRoom, museumSchema, type MuseumDocument } from '../src/core/model';
it('validates the target 50-module / 500-artwork / 5-floor museum', () => {
  const doc: MuseumDocument = {
    ...structuredClone(sample),
    rooms: [],
    connections: [],
    assets: [],
    regions: [],
    unplaced: [],
    entrance: 'r-0-0',
  };
  for (let floor = 0; floor < 5; floor++)
    for (let x = 0; x < 10; x++) {
      const room = { ...defaultRoom(x, 0, floor), id: `r-${floor}-${x}` };
      doc.rooms.push(room);
      if (x > 0)
        doc.connections.push({
          id: `d-${floor}-${x}`,
          a: `r-${floor}-${x - 1}`,
          b: room.id,
          kind: 'door',
          route: [],
        });
      if (x === 0 && floor > 0)
        doc.connections.push({
          id: `s-${floor}`,
          a: `r-${floor - 1}-0`,
          b: room.id,
          kind: 'spiral',
          route: [],
        });
      for (let i = 0; i < 10; i++) {
        const asset = { ...(doc.assets[0] ?? sample.assets[0]), id: `a-${floor}-${x}-${i}` };
        doc.assets.push(asset);
        doc.regions.push({
          id: `e-${floor}-${x}-${i}`,
          wall: `${room.id}:${i < 5 ? 'north' : 'south'}`,
          x: 0.1 + (i % 5) * 1.16,
          y: 0.4,
          w: 1.1,
          h: 2.8,
          assetId: asset.id,
          plaque: 'none',
        });
      }
    }
  museumSchema.parse(doc);
  const start = performance.now(),
    layout = compile(doc),
    ms = performance.now() - start;
  expect(layout.issues).toEqual([]);
  expect(doc.assets).toHaveLength(500);
  expect(ms).toBeLessThan(2000);
  console.info(
    `Target layout validation: ${ms.toFixed(1)} ms; ${layout.walls.length} wall sections; ${doc.assets.length} artworks. This is CPU validation, not a mobile FPS measurement.`,
  );
});
