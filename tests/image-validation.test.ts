import { expect, it } from 'vitest';
import sharp from 'sharp';
import { sample } from '../src/core/sample';
import { trustedVariants } from '../worker/imageValidation';
import type { Env } from '../worker/index';

const asset = { ...sample.assets[0], width: 6000, height: 4001, mime: 'image/jpeg' as const };
function object(bytes: Uint8Array) {
  return { size: bytes.length, body: new Blob([bytes as BlobPart]).stream() } as R2ObjectBody;
}
it('accepts aspect-preserving one-pixel rounding but rejects oversized or unrelated outputs', async () => {
  const master = await sharp({
    create: { width: 2048, height: 1366, channels: 3, background: '#abcd45' },
  })
    .webp()
    .toBuffer();
  let wrong = false;
  const env = {
    IMAGES: {
      info: async () => ({ format: 'image/webp', width: 2048, height: 1366 }),
      input: () => ({
        transform: (options: { width: number; height: number; fit: string }) => ({
          output: async () => {
            expect(options.fit).toBe('scale-down');
            const bytes = await sharp(master)
              .resize(wrong ? 600 : options.width, wrong ? 600 : options.height, {
                fit: 'inside',
                withoutEnlargement: true,
              })
              .webp()
              .toBuffer();
            return { response: () => new Response(bytes as BodyInit) };
          },
        }),
      }),
    },
  } as unknown as Env;
  const variants = await trustedVariants(env, asset, object(new Uint8Array(1)), object(master));
  const first = await sharp(variants[0].bytes).metadata();
  expect(first.width).toBe(511);
  expect(first.height).toBe(341);
  wrong = true;
  await expect(
    trustedVariants(env, asset, object(new Uint8Array(1)), object(master)),
  ).rejects.toMatchObject({ status: 502 });
});
it('distinguishes provider configuration, allowance and temporary failures from invalid images', async () => {
  for (const [code, status, message] of [
    [9422, 503, 'transformation allowance'],
    [9432, 503, 'legacy Image Resizing plan'],
    [9510, 503, 'temporarily unavailable'],
    [9412, 422, 'could not be decoded'],
  ] as const) {
    const env = {
      IMAGES: {
        info: async () => {
          throw Object.assign(Error('provider error'), { code });
        },
      },
    } as unknown as Env;
    await expect(trustedVariants(env, asset, object(new Uint8Array(1)))).rejects.toMatchObject({
      status,
      message: expect.stringContaining(message),
    });
  }
});
