import type { Env } from './index';
import type { Asset } from '../src/core/model';
import { imageDimensions } from '../src/core/imageMetadata';
import { HttpError, readBytes } from './http';
import { uploadLimits } from './uploads';

type Variant = { key: string; bytes: Uint8Array };
/** Originals are private attachments; every inline variant must be fully decoded by the server. */
export function validatedFiles(files: any) {
  return (
    Array.isArray(files) &&
    files.length === 4 &&
    ['images-v1', 'original-private-v1'].includes(files[0]?.validation) &&
    files.slice(1).every((file: any) => file.validation === 'images-v1')
  );
}
export async function trustedVariants(
  env: Env,
  asset: Asset,
  original: R2ObjectBody,
  master?: R2ObjectBody,
): Promise<Variant[]> {
  const variants: Variant[] = [];
  try {
    if (!env.IMAGES) throw new HttpError(503, 'Configure the Cloudflare Images binding.');
    const input = master ?? original;
    if (input.size > (master ? 9_000_000 : 20_000_000))
      throw new HttpError(
        503,
        'A display master is needed for this original. Reload the studio and upload it again.',
      );
    const bytes = await readBytes(input.body, master ? 9_000_000 : 20_000_000);
    const stream = () => new Blob([bytes as BlobPart]).stream();
    const info = await env.IMAGES.info(stream());
    const scale = Math.min(1, 2048 / Math.max(asset.width, asset.height));
    if (
      !('width' in info) ||
      info.format.replace('image/', '') !== (master ? 'webp' : asset.mime.replace('image/', '')) ||
      info.width * info.height > uploadLimits(env).pixels ||
      !(master
        ? info.width === Math.max(1, Math.round(asset.width * scale)) &&
          info.height === Math.max(1, Math.round(asset.height * scale))
        : (info.width === asset.width && info.height === asset.height) ||
          (info.width === asset.height && info.height === asset.width))
    )
      throw Error('Unsupported image');
    for (const edge of [512, 1024, 2048]) {
      const scale = Math.min(1, edge / Math.max(asset.width, asset.height));
      const output = await env.IMAGES.input(stream())
        .transform({
          width: Math.max(1, Math.round(asset.width * scale)),
          height: Math.max(1, Math.round(asset.height * scale)),
          fit: 'contain',
        })
        .output({ format: 'image/webp', quality: 90, anim: false });
      const response = output.response();
      if (!response.ok || !response.body) throw Error('Invalid image output');
      variants.push({
        key: asset.variants[String(edge)],
        bytes: await readBytes(response.body, 9_000_000),
      });
    }
    for (const [index, edge] of [512, 1024, 2048].entries()) {
      const variant = variants[index],
        dims = imageDimensions(variant.bytes, 'image/webp');
      const scale = Math.min(1, edge / Math.max(asset.width, asset.height));
      if (
        !dims ||
        dims.width !== Math.max(1, Math.round(asset.width * scale)) ||
        dims.height !== Math.max(1, Math.round(asset.height * scale))
      )
        throw Error('Display dimensions do not match');
    }
    return variants;
  } catch (error) {
    if (error instanceof HttpError) throw error;
    throw new HttpError(
      422,
      'This image could not be decoded. Re-export it as a standard JPEG, PNG or WebP.',
    );
  }
}
