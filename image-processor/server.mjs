import { createServer } from 'node:http';
import { createHash, timingSafeEqual } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import sharp from 'sharp';

sharp.cache(false);
sharp.concurrency(1);
export function createProcessor({
  token,
  maxBytes = 100_000_000,
  maxPixels = 40_000_000,
  concurrency = 2,
}) {
  if (typeof token !== 'string' || token.length < 32)
    throw Error('IMAGE_PROCESSOR_TOKEN must contain at least 32 characters.');
  if (
    !Number.isSafeInteger(maxBytes) ||
    maxBytes < 1 ||
    maxBytes > 500_000_000 ||
    !Number.isSafeInteger(maxPixels) ||
    maxPixels < 1 ||
    maxPixels > 100_000_000 ||
    !Number.isSafeInteger(concurrency) ||
    concurrency < 1 ||
    concurrency > 8
  )
    throw Error('Invalid processor resource limits.');
  const digest = (value) => createHash('sha256').update(value).digest(),
    expected = digest(`Bearer ${token}`);
  let active = 0;
  const server = createServer(async (request, response) => {
    const fail = (status, message) => {
      response.writeHead(status, {
        'Content-Type': 'text/plain',
        'Cache-Control': 'no-store',
        'X-Content-Type-Options': 'nosniff',
        Connection: 'close',
      });
      response.end(message);
      request.resume();
    };
    if (request.method === 'GET' && request.url === '/health') {
      response.end('ok');
      return;
    }
    if (request.method !== 'POST' || request.url !== '/variants') {
      fail(404, 'Not found');
      return;
    }
    if (!timingSafeEqual(expected, digest(request.headers.authorization ?? ''))) {
      fail(401, 'Unauthorized');
      return;
    }
    if (active >= concurrency) {
      fail(503, 'Processor busy');
      return;
    }
    if (
      !['image/jpeg', 'image/png', 'image/webp'].includes(request.headers['content-type']) ||
      request.headers['content-encoding']
    ) {
      fail(422, 'Unsupported image');
      return;
    }
    if (Number(request.headers['content-length'] ?? 0) > maxBytes) {
      fail(413, 'Original too large');
      return;
    }
    active++;
    try {
      const chunks = [];
      let length = 0;
      for await (const chunk of request) {
        length += chunk.length;
        if (length > maxBytes) {
          fail(413, 'Original too large');
          return;
        }
        chunks.push(chunk);
      }
      const original = Buffer.concat(chunks),
        input = () =>
          sharp(original, { limitInputPixels: maxPixels, failOn: 'warning', sequentialRead: true });
      const declared = request.headers['content-type'];
      const magic =
        declared === 'image/jpeg'
          ? original[0] === 255 && original[1] === 216 && original[2] === 255
          : declared === 'image/png'
            ? original.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
            : original.subarray(0, 4).toString() === 'RIFF' &&
              original.subarray(8, 12).toString() === 'WEBP';
      if (!magic) throw Error('Unsupported original content');
      const metadata = await input().metadata();
      const mime = `image/${metadata.format}`;
      if (
        !['image/jpeg', 'image/png', 'image/webp'].includes(mime) ||
        mime !== request.headers['content-type'] ||
        !metadata.width ||
        !metadata.height ||
        metadata.width * metadata.height > maxPixels
      )
        throw Error('Invalid original');
      const rotated = [5, 6, 7, 8].includes(metadata.orientation);
      const width = rotated ? metadata.height : metadata.width,
        height = rotated ? metadata.width : metadata.height;
      const variants = [],
        outputs = [];
      for (const edge of [512, 1024, 2048]) {
        const scale = Math.min(1, edge / Math.max(width, height));
        // Full native decode and re-encode. EXIF orientation applies to display only;
        // the original is never changed or echoed by this service.
        const bytes = await input()
          .rotate()
          .resize(Math.max(1, Math.round(width * scale)), Math.max(1, Math.round(height * scale)), {
            fit: 'contain',
          })
          .webp({ quality: 90 })
          .toBuffer();
        if (bytes.length > 9_000_000) throw Error('Display output too large');
        variants.push({ size: String(edge), bytes: bytes.length });
        outputs.push(bytes);
      }
      const metadataBytes = Buffer.from(JSON.stringify({ mime, width, height, variants }));
      const prefix = Buffer.alloc(4);
      prefix.writeUInt32BE(metadataBytes.length);
      response.writeHead(200, {
        'Content-Type': 'application/vnd.exhibit.variants',
        'Cache-Control': 'no-store',
        'X-Content-Type-Options': 'nosniff',
      });
      response.end(Buffer.concat([prefix, metadataBytes, ...outputs]));
    } catch {
      if (!response.headersSent) fail(422, 'Image could not be decoded');
      else response.destroy();
    } finally {
      active--;
    }
  });
  server.requestTimeout = 120_000;
  server.headersTimeout = 15_000;
  server.keepAliveTimeout = 5000;
  return server;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const server = createProcessor({
    token: process.env.IMAGE_PROCESSOR_TOKEN,
    maxBytes: Number(process.env.MAX_UPLOAD_BYTES ?? 100_000_000),
    maxPixels: Number(process.env.MAX_IMAGE_PIXELS ?? 40_000_000),
    concurrency: Number(process.env.IMAGE_PROCESSOR_CONCURRENCY ?? 2),
  });
  server.listen(Number(process.env.PORT ?? 8080), '0.0.0.0');
}
