import { type Asset, uid } from '../core/model';
import { api, demo, putBlob } from './storage';
import { imageDimensions } from '../core/imageMetadata';
export function dimensions(width: number, height: number, edge: number) {
  const scale = Math.min(1, edge / Math.max(width, height));
  return {
    width: Math.max(1, Math.round(width * scale)),
    height: Math.max(1, Math.round(height * scale)),
  };
}
export async function uploadImage(
  file: File,
  onProgress: (message: string) => void,
): Promise<Asset> {
  if (!['image/jpeg', 'image/png', 'image/webp'].includes(file.type))
    throw Error('Choose a JPEG, PNG, or WebP image.');
  if (file.size > 25 * 1024 * 1024) throw Error('Images must be no larger than 25 MB.');
  const header = imageDimensions(
    new Uint8Array(await file.slice(0, 262144).arrayBuffer()),
    file.type,
  );
  if (!header || header.width < 1 || header.height < 1)
    throw Error('Could not read this image. Re-export it as a standard JPEG, PNG, or WebP.');
  if (header.width * header.height > 40_000_000)
    throw Error('Images must be no larger than 40 megapixels.');
  onProgress('Reading image…');
  const bitmap = await createImageBitmap(file);
  try {
    if (bitmap.width * bitmap.height > 40_000_000)
      throw Error('Images must be no larger than 40 megapixels.');
    const id = uid(),
      entries: { key: string; blob: Blob; size: string }[] = [
        { key: `originals/${id}`, blob: file, size: 'original' },
      ];
    for (const edge of [512, 1024, 2048]) {
      const d = dimensions(bitmap.width, bitmap.height, edge),
        canvas = document.createElement('canvas');
      canvas.width = d.width;
      canvas.height = d.height;
      canvas.getContext('2d')!.drawImage(bitmap, 0, 0, d.width, d.height);
      const blob = await new Promise<Blob>((resolve, reject) =>
        canvas.toBlob(
          (b) => (b ? resolve(b) : reject(Error('Could not resize this image.'))),
          'image/webp',
          0.9,
        ),
      );
      entries.push({ key: `variants/${id}/${edge}`, blob, size: String(edge) });
    }
    const asset: Asset = {
      id,
      title: file.name.replace(/\.[^.]+$/, ''),
      explanation: '',
      attribution: '',
      width: bitmap.width,
      height: bitmap.height,
      bytes: file.size,
      mime: file.type as Asset['mime'],
      source: entries[0].key,
      variants: Object.fromEntries(entries.slice(1).map((e) => [e.size, e.key])),
      downloadable: false,
      ready: false,
    };
    onProgress('Uploading original and display versions…');
    if (demo) {
      for (const e of entries) await putBlob(e.key, e.blob);
    } else {
      const { uploads } = await api('/uploads', {
        method: 'POST',
        body: JSON.stringify({
          asset,
          files: entries.map((e) => ({ key: e.key, bytes: e.blob.size, mime: e.blob.type })),
        }),
      });
      await Promise.all(
        entries.map(async (e, i) => {
          const response = await fetch(uploads[i].url, {
            method: 'PUT',
            headers: { 'Content-Type': e.blob.type },
            body: e.blob,
          });
          if (!response.ok) throw Error('Upload interrupted. Retry this image.');
        }),
      );
      await api('/uploads/complete', { method: 'POST', body: JSON.stringify({ id }) });
    }
    return { ...asset, ready: true };
  } finally {
    bitmap.close();
  }
}
