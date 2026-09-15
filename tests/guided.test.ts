import { expect, it } from 'vitest';
import { sample } from '../src/core/sample';
import { compile, surfaceHeight, walkStep } from '../src/core/layout';
import { guidedStops, pathToGuidedStop } from '../src/core/guided';
import { boardLines, surfacePlates } from '../src/core/architecture';

it('offers corridor waypoints and local controls for both directions of both stair types', () => {
  const layout = compile(sample),
    stops = guidedStops(sample, layout);
  const corridor = stops.filter((s) => s.rooms?.includes('reading') && s.x < -3 && s.x > -9);
  expect(corridor.length).toBeGreaterThanOrEqual(2);
  for (const room of ['welcome', 'stair-top', 'shop', 'upper']) {
    const trigger = stops.find((s) => s.stairs && s.rooms?.includes(room))!;
    expect(trigger).toBeDefined();
    const origin = trigger.route![0];
    expect(trigger.y).toBe(origin.y);
    const path = pathToGuidedStop(layout, origin, room, trigger);
    expect(path.length).toBeGreaterThan(2);
    expect(path.at(-1)).toEqual(trigger.route!.at(-1));
  }
  const body = { x: -7, y: 0, z: 0 };
  const back = corridor.find((s) => s.x === -5)!;
  const path = pathToGuidedStop(layout, body, 'welcome', back);
  expect(path.at(-1)).toMatchObject({ x: -5, y: 0, z: 0 });
  expect(path.every((p) => p.x >= -7 && p.x <= -5)).toBe(true);
});

it('allows walking beneath high spiral treads but protects low treads and the post', () => {
  const layout = compile(sample);
  const under = { x: 12, z: -7.3, y: 0 };
  expect(surfaceHeight(layout, under, under)).toBe(0);
  const forward = walkStep(layout, under, Math.PI / 2, 1, 0, 0.2);
  expect(forward.x).toBeGreaterThan(12.4);
  expect(forward.y).toBe(0);
  for (const blocked of [
    { x: 12, z: -6, y: 0 },
    { x: 12, z: -4.7, y: 0 },
  ])
    expect(surfaceHeight(layout, blocked, blocked)).toBeNull();
});

it('keeps board seams aligned after subtracting stair openings', () => {
  const layout = compile(sample);
  for (const area of layout.areas) {
    for (const plate of surfacePlates(area, layout.holes))
      for (const z of boardLines(plate)) expect(z / 0.4).toBeCloseTo(Math.round(z / 0.4), 7);
  }
});
