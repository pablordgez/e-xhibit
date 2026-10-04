import { afterEach, expect, it, vi } from 'vitest';
import { workQueue } from '../worker/workQueue';

afterEach(() => vi.useRealTimers());

it('hands limited capacity to waiting work in order and releases each slot only once', async () => {
  const enter = workQueue(1),
    release = await enter(),
    order: number[] = [];
  const first = enter().then((done) => {
    order.push(1);
    return done;
  });
  const second = enter().then((done) => {
    order.push(2);
    return done;
  });
  expect(order).toEqual([]);
  release();
  release();
  const firstDone = await first;
  expect(order).toEqual([1]);
  firstDone();
  const secondDone = await second;
  expect(order).toEqual([1, 2]);
  secondDone();
  (await enter())();
});

it('rejects an overflowing burst and removes timed-out waiters without losing capacity', async () => {
  vi.useFakeTimers();
  const enter = workQueue(1),
    release = await enter();
  const pending = Array.from({ length: 32 }, () => enter());
  const checks = pending.map((p) => expect(p).rejects.toMatchObject({ status: 429 }));
  await expect(enter()).rejects.toMatchObject({ status: 429 });
  await vi.advanceTimersByTimeAsync(60_000);
  await Promise.all(checks);
  release();
  (await enter())();
});
