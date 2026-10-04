import { expect, it } from 'vitest';
import { createProcessor } from '../image-processor/server.mjs';
import sharp from 'sharp';

it('rejects unauthenticated, oversized, malformed and unsupported originals', async () => {
  const token = crypto.randomUUID() + crypto.randomUUID(),
    server = createProcessor({ token, maxBytes: 64 });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address() as { port: number },
    url = `http://127.0.0.1:${address.port}/variants`;
  const headers = { Authorization: `Bearer ${token}`, 'Content-Type': 'image/png' };
  try {
    expect((await fetch(url, { method: 'POST', body: 'fake' })).status).toBe(401);
    expect((await fetch(url, { method: 'POST', headers, body: Buffer.alloc(65) })).status).toBe(
      413,
    );
    expect((await fetch(url, { method: 'POST', headers, body: Buffer.alloc(24) })).status).toBe(
      422,
    );
    expect(
      (
        await fetch(url, {
          method: 'POST',
          headers: { ...headers, 'Content-Type': 'image/svg+xml' },
          body: '<svg/>',
        })
      ).status,
    ).toBe(422);
    expect((await fetch(url, { method: 'POST', headers, body: '<svg/>' })).status).toBe(422);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

it('applies camera EXIF orientation to display variants and removes metadata', async () => {
  const token = crypto.randomUUID() + crypto.randomUUID(),
    server = createProcessor({ token });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    const original = await sharp({
      create: { width: 32, height: 16, channels: 3, background: '#ab34cd' },
    })
      .withMetadata({ orientation: 6 })
      .jpeg()
      .toBuffer();
    const response = await fetch(
      `http://127.0.0.1:${(server.address() as { port: number }).port}/variants`,
      {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'image/jpeg' },
        body: original,
      },
    );
    expect(response.status).toBe(200);
    const bytes = Buffer.from(await response.arrayBuffer()),
      length = bytes.readUInt32BE(0),
      metadata = JSON.parse(bytes.subarray(4, 4 + length).toString());
    expect(metadata).toMatchObject({ mime: 'image/jpeg', width: 16, height: 32 });
    let offset = 4 + length;
    for (const variant of metadata.variants) {
      const info = await sharp(bytes.subarray(offset, offset + variant.bytes)).metadata();
      expect(info).toMatchObject({ format: 'webp', width: 16, height: 32 });
      expect(info.exif).toBeUndefined();
      expect(info.orientation).toBeUndefined();
      offset += variant.bytes;
    }
    expect(offset).toBe(bytes.length);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

it('rejects a decodable original that exceeds the configured pixel budget', async () => {
  const token = crypto.randomUUID() + crypto.randomUUID(),
    server = createProcessor({ token, maxPixels: 100 });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    const original = await sharp({
      create: { width: 11, height: 10, channels: 3, background: '#ab34cd' },
    })
      .png()
      .toBuffer();
    const response = await fetch(
      `http://127.0.0.1:${(server.address() as { port: number }).port}/variants`,
      {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'image/png' },
        body: original,
      },
    );
    expect(response.status).toBe(422);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
