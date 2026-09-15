import { expect, it } from 'vitest';
import { sample } from '../src/core/sample';
import { compile, surfaceHeight, walkStep } from '../src/core/layout';
import { contains, surfacePlates, straightTreads, HEADROOM } from '../src/core/architecture';

it('regular stairs meet a restored upper landing exactly, in either connection direction', () => {
  for (const reverse of [false, true]) {
    const doc = structuredClone(sample);
    const connection = doc.connections.find((c) => c.kind === 'stairs')!;
    if (reverse) [connection.a, connection.b] = [connection.b, connection.a];
    const layout = compile(doc),
      ramp = layout.ramps.find((r) => r.kind === 'stairs')!;
    const steps = straightTreads(ramp);
    expect(steps.at(-1)!.top).toBe(4);
    const area = layout.areas.find((a) => a.roomId === 'stair-top')!;
    const floor = surfacePlates(area, layout.holes);
    const reclaimed = { x: 5.15, y: 4, z: 0 };
    expect(floor.some((p) => contains(p, reclaimed))).toBe(true);
    expect(surfaceHeight(layout, reclaimed, reclaimed)).toBe(4);
    expect(36 - floor.reduce((area, p) => area + p.w * p.d, 0)).toBeLessThan(3.2);
    // Every visible riser beneath the lower ceiling has headroom or an opening.
    for (const step of steps.filter((s) => s.x < 3)) {
      if (3.8 - step.top >= HEADROOM) continue;
      expect(layout.ceilingHoles.some((h) => contains(h, { ...step, y: 3.8 }))).toBe(true);
    }
  }
});

it('spiral boundaries leave diagonal floor space accessible and slide smoothly', () => {
  const layout = compile(sample);
  const corner = { x: 13.7, z: -4.3, y: 0 };
  expect(surfaceHeight(layout, corner, corner)).toBe(0);
  expect(surfaceHeight(layout, { x: 12, z: -6, y: 0 }, { x: 12, z: -6, y: 0 })).toBeNull();
  let body = { x: 12 + 2.2 * Math.cos(1), y: 0, z: -6 + 2.2 * Math.sin(1) };
  const start = { ...body };
  for (let i = 0; i < 12; i++) {
    body = walkStep(layout, body, -Math.PI / 2, 1, 0, 1 / 60);
    expect(surfaceHeight(layout, body, body)).not.toBeNull();
  }
  expect(Math.hypot(body.x - start.x, body.z - start.z)).toBeGreaterThan(0.2);
});

it('ordinary shops gain freestanding displays while stair shops preserve their circulation space', () => {
  const doc = structuredClone(sample);
  doc.rooms.find((r) => r.id === 'reading')!.kind = 'shop';
  const layout = compile(doc);
  expect(layout.issues).toEqual([]);
  const ordinary = layout.furnishings.filter((f) => f.roomId === 'reading');
  expect(ordinary.some((f) => f.kind === 'table')).toBe(true);
  expect(ordinary.some((f) => f.kind === 'plant')).toBe(true);
  expect(ordinary.filter((f) => f.kind === 'shelf').length).toBeGreaterThan(1);
  expect(
    layout.furnishings.filter((f) => f.roomId === 'shop').some((f) => f.kind === 'table'),
  ).toBe(false);
  const counter = layout.furnishings.find((f) => f.roomId === 'welcome' && f.kind === 'stand')!;
  expect(counter.w * counter.d).toBeGreaterThan(1);
});
