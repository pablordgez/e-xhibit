import { expect, it } from 'vitest';
import { sample } from '../src/core/sample';
import { compile, walkStep } from '../src/core/layout';
import { guidedStops, pathToGuidedStop } from '../src/core/guided';
import { straightTreads, wallFacingYaw } from '../src/core/architecture';

it('walks the full spiral in both directions at different distances from the post', () => {
  const layout = compile(sample);
  for (const radius of [0.65, 1.15, 1.8])
    for (const descending of [false, true]) {
      let body = { x: 12 + radius, y: descending ? 4 : 0, z: -6 };
      for (let i = 1; i <= 600; i++) {
        const angle = (descending ? 1 - i / 600 : i / 600) * Math.PI * 2;
        const target = { x: 12 + radius * Math.cos(angle), z: -6 + radius * Math.sin(angle) };
        const dx = target.x - body.x,
          dz = target.z - body.z;
        body = walkStep(layout, body, Math.atan2(dx, dz), 1, 0, Math.hypot(dx, dz) / 2.4);
        expect(Math.hypot(body.x - target.x, body.z - target.z)).toBeLessThan(0.001);
      }
      expect(body.y).toBeCloseTo(descending ? 0 : 4, 2);
    }
});

it('places the whole regular-stair circle clear of the first tread', () => {
  const layout = compile(sample);
  const trigger = guidedStops(sample, layout).find(
    (s) => s.stairs === 'up' && s.rooms?.includes('welcome'),
  )!;
  const first = straightTreads(layout.ramps.find((r) => r.kind === 'stairs')!)[0];
  expect(trigger.x + 0.35).toBeLessThan(first.x - first.d / 2);
});

it('does not backtrack or overshoot on clear routes to room viewing circles', () => {
  const layout = compile(sample),
    stops = guidedStops(sample, layout);
  for (const [body, room, target] of [
    [{ x: -1.5, y: 0, z: 0 }, 'welcome', 'reading'],
    [{ x: 4, y: 0, z: -6 }, 'land', 'light'],
    [{ x: 1.8, y: 0, z: -6 }, 'light', 'land'],
  ] as const) {
    const stop = stops.find((s) => s.roomId === target && !s.route)!;
    const path = pathToGuidedStop(layout, body, room, stop);
    expect(path).toEqual([body, stop]);
  }
});

it('faces textured artwork fronts into the room on all four walls', () => {
  for (const [side, x, z] of [
    ['north', 0, 1],
    ['south', 0, -1],
    ['east', -1, 0],
    ['west', 1, 0],
  ] as const) {
    const angle = wallFacingYaw(side);
    expect(-Math.sin(angle)).toBeCloseTo(x);
    expect(-Math.cos(angle)).toBeCloseTo(z);
  }
});
