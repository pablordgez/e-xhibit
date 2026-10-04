import { afterAll, beforeAll, expect, it } from 'vitest';
import { createServer } from 'node:http';
import { Miniflare, convertV4MiniflareOptions, type V4MiniflareOptions } from 'miniflare';
import { randomFillSync } from 'node:crypto';
import { build } from 'esbuild';
import sharp from 'sharp';
import { sample } from '../src/core/sample';

// Real workerd, R2 CAS and local Images decoder; Supabase alone is a local HTTP fixture.
const owner = '00000000-0000-4000-8000-000000000001';
const tables: Record<string, any[]> = {
  museum_members: [{ user_id: owner, role: 'owner' }],
  museum_assets: [],
};
const provider = createServer(async (request, response) => {
  const url = new URL(request.url!, 'http://local.test');
  response.setHeader('Content-Type', 'application/json');
  if (url.pathname === '/auth/v1/user') {
    response.end(JSON.stringify({ id: owner }));
    return;
  }
  const table = url.pathname.split('/').at(-1)!;
  let rows = tables[table] ?? [];
  const matches = (row: any) =>
    [...url.searchParams].every(([key, value]) =>
      value.startsWith('in.(')
        ? value.slice(4, -1).split(',').includes(String(row[key]))
        : !value.startsWith('eq.') || String(row[key]) === value.slice(3),
    );
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(Buffer.from(chunk));
  const raw = Buffer.concat(chunks).toString();
  if (request.method === 'POST') {
    const value = JSON.parse(raw);
    rows.push(value);
    rows = [value];
  } else {
    rows = rows.filter(matches);
    if (request.method === 'PATCH') for (const row of rows) Object.assign(row, JSON.parse(raw));
    else if (request.method === 'GET') {
      const offset = Number(url.searchParams.get('offset') ?? 0),
        limit = Number(url.searchParams.get('limit') ?? 1000);
      rows = rows.slice(offset, offset + limit);
    }
  }
  response.end(JSON.stringify(rows));
});
let runtime: Miniflare;
beforeAll(async () => {
  await new Promise<void>((resolve) => provider.listen(0, '127.0.0.1', resolve));
  const address = provider.address() as { port: number };
  const bundle = await build({
    entryPoints: ['worker/index.ts'],
    bundle: true,
    write: false,
    format: 'esm',
    platform: 'browser',
  });
  const runtimeOptions: V4MiniflareOptions = {
    name: 'museum',
    modules: true,
    script: bundle.outputFiles[0].text,
    compatibilityDate: '2025-09-01',
    r2Buckets: ['MUSEUM', 'DISPLAY'],
    images: { binding: 'IMAGES' },
    ratelimits: {
      AUTH_LIMITER: { namespace_id: '1001', simple: { limit: 240, period: 60 } },
      CREATE_LIMITER: { namespace_id: '1002', simple: { limit: 120, period: 60 } },
    },
    serviceBindings: { ASSETS: () => new Response('sample') },
    bindings: {
      SUPABASE_URL: `http://127.0.0.1:${address.port}`,
      SUPABASE_SERVICE_ROLE_KEY: 'local-fixture',
      APP_ORIGIN: 'https://museum.test',
    },
  };
  runtime = new Miniflare(convertV4MiniflareOptions(runtimeOptions));
}, 30_000);

afterAll(async () => {
  await new Promise<void>((resolve) => {
    provider.close(() => resolve());
    provider.closeAllConnections();
  });
  await runtime?.dispose();
}, 30_000);

async function call(path: string, body: unknown) {
  return runtime.dispatchFetch('https://museum.test/api' + path, {
    method: 'POST',
    headers: {
      Authorization: 'Bearer local-fixture',
      Origin: 'https://museum.test',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });
}
it('uploads and migrates originals above 20 MB using native Images and a browser-sized master, preserving exact originals and exhibit data', async () => {
  const width = 3001,
    height = 2503;
  const original = await sharp(randomFillSync(Buffer.alloc(width * height * 3)), {
    raw: { width, height, channels: 3 },
  })
    .jpeg({ quality: 100, chromaSubsampling: '4:4:4' })
    .toBuffer();
  expect(original.length).toBeGreaterThan(20_000_000);
  const master = await sharp(original)
    .resize(2048, Math.round((height * 2048) / width))
    .webp({ quality: 90 })
    .toBuffer();
  const bucket = await runtime.getR2Bucket('MUSEUM');
  for (const legacy of [false, true]) {
    const id = crypto.randomUUID();
    const asset = {
      ...sample.assets[0],
      id,
      title: 'Finished camera photograph',
      explanation: 'Retain caption',
      source: `originals/${id}`,
      variants: Object.fromEntries(['512', '1024', '2048'].map((s) => [s, `variants/${id}/${s}`])),
      width,
      height,
      bytes: original.length,
      mime: 'image/jpeg',
      ready: legacy,
    };
    const document = structuredClone(sample);
    document.assets.push(asset as any);
    document.regions[0].assetId = id;
    const before = JSON.stringify(document);
    if (legacy) {
      await bucket.put(
        asset.source,
        original.buffer.slice(original.byteOffset, original.byteOffset + original.byteLength),
      );
      await bucket.put(asset.variants['2048'], master, {
        httpMetadata: { contentType: 'text/html', contentEncoding: 'gzip' },
      });
      tables.museum_assets.push({
        id,
        ready: true,
        created_by: owner,
        asset,
        files: [{ key: asset.source, bytes: original.length, mime: 'image/jpeg' }],
      });
    } else {
      expect(
        (
          await call('/uploads', {
            asset,
            files: [
              { key: asset.source, bytes: original.length, mime: 'image/jpeg' },
              { key: `masters/${id}`, bytes: master.length, mime: 'image/webp' },
            ],
          })
        ).status,
      ).toBe(200);
      for (const [suffix, data, mime] of [
        ['file', original, 'image/jpeg'],
        ['master', master, 'image/webp'],
      ] as const) {
        const response = await runtime.dispatchFetch(
          `https://museum.test/api/uploads/${id}/${suffix}`,
          {
            method: 'PUT',
            headers: {
              Authorization: 'Bearer local-fixture',
              Origin: 'https://museum.test',
              'Content-Type': mime,
            },
            body: data,
          },
        );
        expect(response.status, await response.text()).toBe(200);
      }
    }
    const response = await call(legacy ? '/uploads/revalidate' : '/uploads/complete', { id });
    expect(response.status, await response.text()).toBe(200);
    expect(JSON.stringify(document)).toBe(before);
    expect(tables.museum_assets.find((row) => row.id === id).asset).toEqual({
      ...asset,
      ready: true,
    });
    const saved = await bucket.get(asset.source);
    expect(Buffer.compare(Buffer.from(await saved!.arrayBuffer()), original)).toBe(0);
    expect(saved!.httpMetadata).toMatchObject({
      contentType: 'image/jpeg',
      contentDisposition: 'attachment',
      cacheControl: 'no-store',
    });
    expect(tables.museum_assets.find((row) => row.id === id).files[0].validation).toBe(
      'original-private-v1',
    );
    for (const [edge, key] of Object.entries(asset.variants)) {
      const output = await bucket.get(key),
        scale = Number(edge) / width;
      expect(await sharp(Buffer.from(await output!.arrayBuffer())).metadata()).toMatchObject({
        format: 'webp',
        width: Math.round(width * scale),
        height: Math.round(height * scale),
      });
      expect(output!.httpMetadata?.contentEncoding).toBeUndefined();
      expect(output!.httpMetadata?.contentType).toBe('image/webp');
    }
    // New readiness markers also satisfy the publication gate; empty unvalidated files do not.
    const status = await runtime.dispatchFetch(`https://museum.test/api/asset-status?ids=${id}`, {
      headers: { Authorization: 'Bearer local-fixture' },
    });
    expect(await status.json()).toEqual([{ id, validated: true }]);
    if (legacy) {
      tables.museum_drafts = [{ id: true, revision: 7, document }];
      const start = await call('/publish', { revision: 7, previous: null });
      expect(start.status, start.status === 200 ? '' : await start.text()).toBe(200);
      let progress = (await start.json()) as { id: string; cursor: number; done: boolean };
      while (!progress.done) {
        const step = await call(`/publish/${progress.id}/step`, { cursor: progress.cursor });
        expect(step.status, step.status === 200 ? '' : await step.text()).toBe(200);
        progress = (await step.json()) as typeof progress;
      }
      const publicKey = `published/${progress.id}/variants/${id}/2048`;
      const image = await runtime.dispatchFetch(
        'https://museum.test/api/media/' + encodeURIComponent(publicKey),
      );
      expect(image.status).toBe(200);
      expect(image.headers.get('X-Content-Type-Options')).toBe('nosniff');
      expect(await sharp(Buffer.from(await image.arrayBuffer())).metadata()).toMatchObject({
        format: 'webp',
        width: 2048,
        height: Math.round((height * 2048) / width),
      });
      const frozenOriginal = await bucket.get(`published/${progress.id}/originals/${id}`);
      expect(frozenOriginal!.httpMetadata?.contentDisposition).toBe('attachment');
      // Consume the large R2 stream: an unread body can keep Miniflare's proxy open.
      expect(Buffer.compare(Buffer.from(await frozenOriginal!.arrayBuffer()), original)).toBe(0);
      // Public inline delivery never accepts originals, including a header-valid opaque original.
      expect(
        (
          await runtime.dispatchFetch(
            'https://museum.test/api/media/' +
              encodeURIComponent(`published/${progress.id}/originals/${id}`),
          )
        ).status,
      ).toBe(404);
    }
  }
}, 60_000);

it('prepares smaller legacy originals from existing rounded display masters and recovers damaged masters without changing artwork', async () => {
  const width = 6000,
    height = 4001;
  const original = await sharp({ create: { width, height, channels: 3, background: '#ab34cd' } })
    .jpeg()
    .toBuffer();
  const master = await sharp(original).resize(2048, 1366).webp().toBuffer();
  const bucket = await runtime.getR2Bucket('MUSEUM');
  for (const damaged of [false, true]) {
    const id = crypto.randomUUID();
    const asset = {
      ...sample.assets[0],
      id,
      width,
      height,
      bytes: original.length,
      mime: 'image/jpeg',
      source: `originals/${id}`,
      ready: true,
      variants: Object.fromEntries(
        ['512', '1024', '2048'].map((size) => [size, `variants/${id}/${size}`]),
      ),
    };
    const before = JSON.stringify(asset);
    tables.museum_assets.push({
      id,
      ready: true,
      asset,
      created_by: owner,
      files: [{ key: asset.source, bytes: original.length, mime: asset.mime }],
    });
    await bucket.put(asset.source, original);
    await bucket.put(asset.variants['2048'], damaged ? Buffer.from('not an image') : master);
    const response = await call('/uploads/revalidate', { id });
    expect(response.status, await response.text()).toBe(200);
    const saved = tables.museum_assets.find((row) => row.id === id);
    expect(JSON.stringify(saved.asset)).toBe(before);
    expect(saved.files[0].validation).toBe(damaged ? 'images-v1' : 'original-private-v1');
    expect(Buffer.from(await (await bucket.get(asset.source))!.arrayBuffer())).toEqual(original);
    for (const [edge, key] of Object.entries(asset.variants)) {
      const metadata = await sharp(
        Buffer.from(await (await bucket.get(key))!.arrayBuffer()),
      ).metadata();
      expect(metadata.format).toBe('webp');
      if (!damaged && edge === '512') expect(metadata.width).toBe(511);
      expect(Math.max(metadata.width!, metadata.height!)).toBeLessThanOrEqual(Number(edge));
      expect(Math.abs(metadata.width! - Number(edge))).toBeLessThanOrEqual(1);
      expect(
        Math.abs(metadata.height! - Math.round((height * Number(edge)) / width)),
      ).toBeLessThanOrEqual(1);
    }
  }
}, 30_000);

it('rejects malformed display masters even when the original header is acceptable', async () => {
  const original = await sharp({
    create: { width: 16, height: 32, channels: 3, background: '#ab34cd' },
  })
    .png()
    .toBuffer();
  const master = Buffer.alloc(30);
  master.write('RIFF', 0);
  master.writeUInt32LE(22, 4);
  master.write('WEBPVP8X', 8);
  master.writeUInt32LE(10, 16);
  master[24] = 15;
  master[27] = 31;
  const id = crypto.randomUUID();
  const asset = {
    ...sample.assets[0],
    id,
    width: 16,
    height: 32,
    bytes: original.length,
    mime: 'image/png',
    ready: false,
    source: `originals/${id}`,
    variants: Object.fromEntries(['512', '1024', '2048'].map((s) => [s, `variants/${id}/${s}`])),
  };
  expect(
    (
      await call('/uploads', {
        asset,
        files: [
          { key: asset.source, bytes: original.length, mime: 'image/png' },
          { key: `masters/${id}`, bytes: master.length, mime: 'image/webp' },
        ],
      })
    ).status,
  ).toBe(200);
  for (const [suffix, data, mime] of [
    ['file', original, 'image/png'],
    ['master', master, 'image/webp'],
  ] as const)
    expect(
      (
        await runtime.dispatchFetch(`https://museum.test/api/uploads/${id}/${suffix}`, {
          method: 'PUT',
          headers: {
            Authorization: 'Bearer local-fixture',
            Origin: 'https://museum.test',
            'Content-Type': mime,
          },
          body: data,
        })
      ).status,
    ).toBe(200);
  const response = await call('/uploads/complete', { id });
  expect(response.status, await response.text()).toBe(422);
  expect(tables.museum_assets.find((row) => row.id === id).ready).toBe(false);
  expect(await (await runtime.getR2Bucket('MUSEUM')).get(asset.source)).toBeNull();
}, 30_000);
it('fully decodes real originals, creates proportional WebP variants, and rejects the forged PNG chain', async () => {
  const original = await sharp({
    create: { width: 16, height: 32, channels: 3, background: '#ab34cd' },
  })
    .png()
    .toBuffer();
  for (const valid of [true, false]) {
    const id = crypto.randomUUID(),
      bytes = valid ? original : Buffer.alloc(24);
    if (!valid) {
      bytes.set([137, 80, 78, 71, 13, 10, 26, 10]);
      bytes.writeUInt32BE(16, 16);
      bytes.writeUInt32BE(32, 20);
    }
    const asset = {
      ...sample.assets[0],
      id,
      source: `originals/${id}`,
      variants: Object.fromEntries(['512', '1024', '2048'].map((s) => [s, `variants/${id}/${s}`])),
      width: 16,
      height: 32,
      bytes: bytes.length,
      mime: 'image/png',
      ready: false,
    };
    expect(
      (
        await call('/uploads', {
          asset,
          files: [{ key: asset.source, bytes: bytes.length, mime: asset.mime }],
        })
      ).status,
    ).toBe(200);
    expect(
      (
        await runtime.dispatchFetch(`https://museum.test/api/uploads/${id}/file`, {
          method: 'PUT',
          headers: {
            Authorization: 'Bearer local-fixture',
            Origin: 'https://museum.test',
            'Content-Type': 'image/png',
          },
          body: bytes,
        })
      ).status,
    ).toBe(200);
    const complete = await call('/uploads/complete', { id });
    expect(complete.status, await complete.text()).toBe(valid ? 200 : 422);
    const record = tables.museum_assets.find((row) => row.id === id);
    expect(record.ready).toBe(valid);
    const bucket = await runtime.getR2Bucket('MUSEUM');
    if (valid) {
      const frozen = await bucket.get(asset.source);
      expect(Buffer.from(await frozen!.arrayBuffer())).toEqual(original);
      for (const key of Object.values(asset.variants)) {
        const image = await bucket.get(key);
        const info = await sharp(Buffer.from(await image!.arrayBuffer())).metadata();
        expect(info).toMatchObject({ format: 'webp', width: 16, height: 32 });
        expect(image!.httpMetadata).toMatchObject({
          contentType: 'image/webp',
          cacheControl: 'no-store',
        });
        expect(image!.httpMetadata?.contentEncoding).toBeUndefined();
      }
    } else expect(await bucket.get(asset.source)).toBeNull();
  }
}, 30_000);
