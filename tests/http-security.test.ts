import { expect, it } from 'vitest';
import { body, readBytes } from '../worker/http';
import { compile } from '../src/core/layout';
import { sample } from '../src/core/sample';

it('counts multibyte JSON as bytes, without relying on Content-Length', async () => {
  const request = new Request('https://museum.test', {
    method: 'POST',
    body: JSON.stringify({ text: '界'.repeat(30) }),
  });
  await expect(body(request, 64)).rejects.toMatchObject({ status: 413 });
});
it('cancels oversized streams before consuming their remaining chunks', async () => {
  let canceled = false,
    pulls = 0;
  const stream = new ReadableStream<Uint8Array>({
    pull(controller) {
      pulls++;
      controller.enqueue(new Uint8Array(32));
    },
    cancel() {
      canceled = true;
    },
  });
  await expect(readBytes(stream, 64)).rejects.toMatchObject({ status: 413 });
  expect(canceled).toBe(true);
  expect(pulls).toBeLessThanOrEqual(4);
});
it('rejects malformed UTF-8 instead of replacing bytes in security-sensitive input', async () => {
  const request = new Request('https://museum.test', {
    method: 'POST',
    body: new Uint8Array([123, 34, 120, 34, 58, 34, 255, 34, 125]),
  });
  await expect(body(request)).rejects.toMatchObject({ status: 400 });
});
it('bounds shared-draft diagnostic amplification at the maximum region count', () => {
  const document = structuredClone(sample);
  document.regions = Array.from({ length: 3000 }, (_, i) => ({
    ...document.regions[0],
    id: `overlap-${i}`,
    assetId: undefined,
  }));
  const start = performance.now(),
    layout = compile(document);
  expect(layout.issues.length).toBeLessThanOrEqual(100);
  expect(layout.issues.some((issue) => issue.code === 'region-overlap')).toBe(true);
  expect(JSON.stringify(layout.issues).length).toBeLessThan(20_000);
  expect(performance.now() - start).toBeLessThan(1000);
});
