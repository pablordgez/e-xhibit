export class HttpError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}

/** Count wire bytes while consuming the stream, including requests without Content-Length. */
export async function readBytes(stream: ReadableStream<Uint8Array> | null, limit: number) {
  if (!stream) return new Uint8Array();
  const reader = stream.getReader(),
    chunks: Uint8Array[] = [];
  let length = 0;
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      length += value.byteLength;
      if (length > limit) {
        await reader.cancel();
        throw new HttpError(413, 'Request is too large.');
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.length;
  }
  return bytes;
}

export async function body(request: Request, limit = 64 * 1024) {
  const declared = Number(request.headers.get('Content-Length') ?? 0);
  if (declared > limit) throw new HttpError(413, 'Request is too large.');
  const bytes = await readBytes(request.body, limit);
  try {
    return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
  } catch {
    throw new HttpError(400, 'Request must contain valid UTF-8 JSON.');
  }
}
