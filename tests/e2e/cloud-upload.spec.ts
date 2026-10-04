import { test, expect } from '@playwright/test';
import { build } from 'esbuild';
import { createHash } from 'node:crypto';
import sharp from 'sharp';

test('cloud uploads automatically resize an original above 20 MB and preserve its exact bytes', async ({
  page,
}) => {
  // Exercise the production upload function with a real browser decoder/canvas.
  // Only authentication/storage transport is replaced; real native server decoding
  // and legacy migration are exercised separately in worker-images.integration.test.ts.
  const bundle = await build({
    entryPoints: ['src/lib/images.ts'],
    bundle: true,
    write: false,
    format: 'iife',
    globalName: 'cloudImages',
    platform: 'browser',
    plugins: [
      {
        name: 'test-cloud-transport',
        setup(builder) {
          builder.onResolve({ filter: /^\.\/storage$/ }, () => ({
            path: 'storage',
            namespace: 'fixture',
          }));
          builder.onLoad({ filter: /.*/, namespace: 'fixture' }, () => ({
            contents: `
        export const demo = false;
        export const imageUploadLimits = async () => ({ bytes: 100000000, pixels: 100000000 });
        export const putBlob = () => { throw Error('Local storage must not be used'); };
        export async function api(path, init = {}) {
          const response = await fetch('/api' + path, { ...init, headers: {
            Authorization: 'Bearer browser-fixture', 'Content-Type': 'application/json', ...init.headers } });
          if (!response.ok) throw Error('Upload failed');
          return response.json();
        }
      `,
          }));
        },
      },
    ],
  });
  let declaration: any, original: Buffer | undefined, master: Buffer | undefined;
  const requests: string[] = [];
  await page.route('**/api/uploads**', async (route) => {
    const request = route.request(),
      path = new URL(request.url()).pathname;
    requests.push(path);
    expect(request.headers().authorization).toBe('Bearer browser-fixture');
    if (path === '/api/uploads') declaration = request.postDataJSON();
    else if (path.endsWith('/file')) original = request.postDataBuffer()!;
    else if (path.endsWith('/master')) master = request.postDataBuffer()!;
    await route.fulfill({
      json: path.endsWith('/complete') ? { asset: { ...declaration.asset, ready: true } } : {},
    });
  });
  await page.goto('/');
  await page.addScriptTag({ content: bundle.outputFiles[0].text });
  const result = await page.evaluate(async () => {
    const canvas = document.createElement('canvas');
    canvas.width = 2801;
    canvas.height = 3001;
    const context = canvas.getContext('2d')!,
      pixels = context.createImageData(canvas.width, canvas.height);
    // A deterministic noisy image avoids a tiny compressed file and keeps tests reproducible.
    let state = 123456789;
    for (let offset = 0; offset < pixels.data.length; offset += 4) {
      state ^= state << 13;
      state ^= state >>> 17;
      state ^= state << 5;
      pixels.data[offset] = state & 255;
      pixels.data[offset + 1] = (state >>> 8) & 255;
      pixels.data[offset + 2] = (state >>> 16) & 255;
      pixels.data[offset + 3] = 255;
    }
    context.putImageData(pixels, 0, 0);
    const blob = await new Promise<Blob>((resolve) =>
      canvas.toBlob((blob) => resolve(blob!), 'image/png'),
    );
    const hash = [
      ...new Uint8Array(await crypto.subtle.digest('SHA-256', await blob.arrayBuffer())),
    ]
      .map((byte) => byte.toString(16).padStart(2, '0'))
      .join('');
    const messages: string[] = [];
    const asset = await (window as any).cloudImages.uploadImage(
      new File([blob], 'camera-photo.png', { type: 'image/png' }),
      (message: string) => messages.push(message),
    );
    return { asset, hash, messages };
  });
  expect(original!.length).toBeGreaterThan(20_000_000);
  expect(createHash('sha256').update(original!).digest('hex')).toBe(result.hash);
  expect(result.asset).toMatchObject({
    width: 2801,
    height: 3001,
    ready: true,
    bytes: original!.length,
  });
  expect(declaration.files).toEqual([
    { key: result.asset.source, bytes: original!.length, mime: 'image/png' },
    { key: `masters/${result.asset.id}`, bytes: master!.length, mime: 'image/webp' },
  ]);
  expect(master!.length).toBeLessThan(9_000_000);
  expect(await sharp(master!).metadata()).toMatchObject({
    format: 'webp',
    width: Math.round((2801 * 2048) / 3001),
    height: 2048,
  });
  expect(requests).toEqual([
    '/api/uploads',
    `/api/uploads/${result.asset.id}/file`,
    `/api/uploads/${result.asset.id}/master`,
    '/api/uploads/complete',
  ]);
  expect(result.messages).toContain('Preparing display versions…');

  // Camera rotation must survive the browser master path, while metadata stays
  // in the untouched private original rather than the inline display image.
  const cameraOriginal = await sharp({
    create: { width: 32, height: 16, channels: 3, background: '#ab34cd' },
  })
    .withMetadata({ orientation: 6 })
    .jpeg()
    .toBuffer();
  const cameraAsset = await page.evaluate(async (encoded) => {
    const bytes = Uint8Array.from(atob(encoded), (character) => character.charCodeAt(0));
    return (window as any).cloudImages.uploadImage(
      new File([bytes], 'camera-rotation.jpg', { type: 'image/jpeg' }),
      () => {},
    );
  }, Buffer.from(cameraOriginal).toString('base64'));
  expect(original).toEqual(cameraOriginal);
  expect(cameraAsset).toMatchObject({ width: 16, height: 32, ready: true });
  const cameraMaster = await sharp(master!).metadata();
  expect(cameraMaster).toMatchObject({ format: 'webp', width: 16, height: 32 });
  expect(cameraMaster.exif).toBeUndefined();
  expect(cameraMaster.orientation).toBeUndefined();
});
