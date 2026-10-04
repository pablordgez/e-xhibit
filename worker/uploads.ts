import type { Env } from './index';
import { HttpError } from './http';
import { reservation } from './resources';

export function uploadLimits(env: Env) {
  const bytes = Number(env.MAX_UPLOAD_BYTES ?? 100_000_000),
    pixels = Number(env.MAX_IMAGE_PIXELS ?? 100_000_000);
  if (!Number.isSafeInteger(bytes) || bytes < 1 || bytes > 500_000_000)
    throw new HttpError(503, 'MAX_UPLOAD_BYTES must be between 1 and 500000000.');
  if (!Number.isSafeInteger(pixels) || pixels < 1 || pixels > 100_000_000)
    throw new HttpError(503, 'MAX_IMAGE_PIXELS must be between 1 and 100000000.');
  return { bytes, pixels };
}

/** Multipart parts stay uncommitted until the exact byte count passes. Abort on any failure. */
export async function receiveOriginal(
  request: Request,
  env: Env,
  id: string,
  key: string,
  expected: number,
  mime: string,
  master = false,
) {
  const claimKey = `control/uploads/${id}${master ? '.master' : ''}.json`;
  await reservation(env, 'uploads', id);
  const claim = await env.MUSEUM.put(claimKey, JSON.stringify({ key }), {
    onlyIf: { etagDoesNotMatch: '*' },
  });
  if (!claim)
    throw new HttpError(
      409,
      'Image file already uploaded or in progress. Complete it or retry with a new upload.',
    );
  const upload = await env.MUSEUM.createMultipartUpload(key, {
    httpMetadata: {
      contentType: mime,
      cacheControl: 'no-store',
      ...(!master ? { contentDisposition: 'attachment' } : {}),
    },
  });
  await env.MUSEUM.put(claimKey, JSON.stringify({ key, uploadId: upload.uploadId }));
  const reader = request.body?.getReader();
  const parts: R2UploadedPart[] = [];
  const buffer = new Uint8Array(8 * 1024 * 1024);
  let filled = 0,
    length = 0;
  try {
    if (!reader) throw new HttpError(422, 'Upload is empty.');
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      length += value.length;
      if (length > expected) throw new HttpError(413, 'Upload is too large.');
      for (let offset = 0; offset < value.length;) {
        const size = Math.min(buffer.length - filled, value.length - offset);
        buffer.set(value.subarray(offset, offset + size), filled);
        offset += size;
        filled += size;
        if (filled === buffer.length) {
          await reservation(env, 'uploads', id);
          parts.push(await upload.uploadPart(parts.length + 1, buffer));
          filled = 0;
        }
      }
    }
    if (length !== expected) throw new HttpError(422, 'Upload length does not match.');
    await reservation(env, 'uploads', id);
    if (filled) parts.push(await upload.uploadPart(parts.length + 1, buffer.subarray(0, filled)));
    await upload.complete(parts);
    await env.MUSEUM.put(claimKey, JSON.stringify({ key }));
  } catch (error) {
    await reader?.cancel().catch(() => {});
    await upload.abort().catch(() => {});
    throw error;
  } finally {
    reader?.releaseLock();
  }
}
