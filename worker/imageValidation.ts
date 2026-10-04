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
    if (env.IMAGE_PROCESSOR_URL && !master) {
      const endpoint = new URL(env.IMAGE_PROCESSOR_URL);
      if (
        endpoint.protocol !== 'https:' ||
        endpoint.username ||
        endpoint.password ||
        !env.IMAGE_PROCESSOR_TOKEN
      )
        throw new HttpError(503, 'Configure a trusted HTTPS image processor and its secret token.');
      const response = await fetch(endpoint, {
        method: 'POST',
        redirect: 'manual',
        headers: {
          Authorization: `Bearer ${env.IMAGE_PROCESSOR_TOKEN}`,
          'Content-Type': asset.mime,
          'Content-Length': String(original.size),
        },
        body: original.body,
        signal: AbortSignal.timeout(120_000),
      });
      if (!response.ok)
        throw new HttpError(
          response.status === 422 || response.status === 413 ? 422 : 503,
          'Image processing failed. Check the original and image processor configuration.',
        );
      if (response.headers.get('Content-Type') !== 'application/vnd.exhibit.variants')
        throw Error('Invalid processor response');
      const data = await readBytes(response.body, 27_004_100);
      if (data.length < 4) throw Error('Invalid processor response');
      const length = new DataView(data.buffer, data.byteOffset, data.byteLength).getUint32(0);
      if (length > 4096 || length + 4 > data.length) throw Error('Invalid processor metadata');
      const meta = JSON.parse(
        new TextDecoder('utf-8', { fatal: true }).decode(data.subarray(4, 4 + length)),
      );
      if (
        meta.width !== asset.width ||
        meta.height !== asset.height ||
        meta.mime !== asset.mime ||
        meta.variants?.length !== 3
      )
        throw Error('Image dimensions or format do not match');
      let offset = 4 + length;
      for (const [index, edge] of [512, 1024, 2048].entries()) {
        const item = meta.variants[index];
        if (
          item.size !== String(edge) ||
          !Number.isSafeInteger(item.bytes) ||
          item.bytes <= 0 ||
          item.bytes > 9_000_000 ||
          offset + item.bytes > data.length
        )
          throw Error('Invalid display output');
        variants.push({
          key: asset.variants[String(edge)],
          bytes: data.subarray(offset, offset + item.bytes),
        });
        offset += item.bytes;
      }
      if (offset !== data.length) throw Error('Unexpected processor content');
    } else {
      if (!env.IMAGES)
        throw new HttpError(503, 'Configure the Images binding or a trusted image processor.');
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
        info.format.replace('image/', '') !==
          (master ? 'webp' : asset.mime.replace('image/', '')) ||
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
