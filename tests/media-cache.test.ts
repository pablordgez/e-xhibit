import { afterEach, expect, it, vi } from 'vitest';
import { mediaCache } from '../src/lib/mediaCache';

afterEach(() => vi.useRealTimers());
function fixture() {
  const load = vi.fn(async (keys: string[]) => ({
    urls: keys.filter((key) => key !== 'missing').map((key) => ({ key, url: 'signed-' + key })),
    expiresIn: 240,
  }));
  return { load, cache: mediaCache(load) };
}
it('coalesces a 43-artwork collection and deduplicates simultaneous and repeated consumers', async () => {
  vi.useFakeTimers();
  const { load, cache } = fixture();
  const keys = Array.from({ length: 43 }, (_, index) => String(index));
  const requests = keys.map((key) => cache.get(key));
  const duplicate = cache.get('0');
  await vi.advanceTimersByTimeAsync(25);
  expect(await Promise.all(requests)).toHaveLength(43);
  expect(await duplicate).toBe('signed-0');
  expect(await cache.get('0')).toBe('signed-0');
  expect(load).toHaveBeenCalledTimes(1);
  expect(load.mock.calls[0][0]).toEqual(keys);
});
it('bounds signing batches and renews before signature expiry or after an explicit invalidation', async () => {
  vi.useFakeTimers();
  const { load, cache } = fixture();
  const requests = Array.from({ length: 120 }, (_, index) => cache.get(String(index)));
  await vi.advanceTimersByTimeAsync(25);
  await Promise.all(requests);
  expect(load.mock.calls.map(([keys]) => keys.length)).toEqual([50, 50, 20]);
  await vi.advanceTimersByTimeAsync(240_000);
  const refreshed = cache.get('0');
  await vi.advanceTimersByTimeAsync(25);
  await refreshed;
  cache.invalidate('0');
  const retried = cache.get('0');
  await vi.advanceTimersByTimeAsync(25);
  await retried;
  expect(load).toHaveBeenCalledTimes(5);
});
it('does not poison valid images with a missing record and discards failures and old-session entries', async () => {
  vi.useFakeTimers();
  const { load, cache } = fixture();
  const valid = cache.get('valid'),
    missing = expect(cache.get('missing')).rejects.toThrow('unavailable');
  await vi.advanceTimersByTimeAsync(25);
  expect(await valid).toBe('signed-valid');
  await missing;
  cache.clear();
  load.mockRejectedValueOnce(Error('Network failure'));
  const failed = expect(cache.get('valid')).rejects.toThrow('Network failure');
  await vi.advanceTimersByTimeAsync(25);
  await failed;
  const recovered = cache.get('valid');
  await vi.advanceTimersByTimeAsync(25);
  expect(await recovered).toBe('signed-valid');
  expect(load).toHaveBeenCalledTimes(3);
});
