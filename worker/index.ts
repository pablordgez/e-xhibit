import { AwsClient } from 'aws4fetch';
import { z } from 'zod';
import { museumSchema, assetSchema, type MuseumDocument, type Asset } from '../src/core/model';
import { compile } from '../src/core/layout';
import { sample } from '../src/core/sample';
import { publicDocument } from '../src/core/publication';
import { imageDimensions } from '../src/core/imageMetadata';
export interface Env {
  MUSEUM: R2Bucket;
  DISPLAY?: R2Bucket;
  ASSETS: Fetcher;
  SUPABASE_URL: string;
  SUPABASE_SERVICE_ROLE_KEY: string;
  APP_ORIGIN: string;
  R2_ACCOUNT_ID: string;
  R2_BUCKET_NAME: string;
  R2_ACCESS_KEY_ID: string;
  R2_SECRET_ACCESS_KEY: string;
}
type Publication = { id: string; name: string; createdAt: string; document: MuseumDocument };
type Draft = { id: boolean; revision: number; document: MuseumDocument };
class HttpError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}
const json = (data: unknown, status = 200, headers: HeadersInit = {}) =>
  Response.json(data, {
    status,
    headers: { 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', ...headers },
  });
async function db(env: Env, path: string, init: RequestInit = {}) {
  const r = await fetch(`${env.SUPABASE_URL}/rest/v1/${path}`, {
    ...init,
    headers: {
      apikey: env.SUPABASE_SERVICE_ROLE_KEY,
      Authorization: `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`,
      'Content-Type': 'application/json',
      Prefer: 'return=representation',
      ...init.headers,
    },
  });
  if (!r.ok)
    throw new HttpError(
      503,
      'The museum database is unavailable. Your current publication is unchanged.',
    );
  return r.status === 204 ? null : (r.json() as Promise<any>);
}
async function identity(request: Request, env: Env) {
  const auth = request.headers.get('Authorization');
  if (!auth?.startsWith('Bearer ')) throw new HttpError(401, 'Sign in to edit this museum.');
  const response = await fetch(`${env.SUPABASE_URL}/auth/v1/user`, {
    headers: { Authorization: auth, apikey: env.SUPABASE_SERVICE_ROLE_KEY },
  });
  if (!response.ok) throw new HttpError(401, 'Your session has expired. Sign in again.');
  const user = (await response.json()) as { id: string; email: string };
  const members = await db(
    env,
    `museum_members?user_id=eq.${encodeURIComponent(user.id)}&select=user_id,email,role`,
  );
  if (!members.length)
    throw new HttpError(403, 'Your account does not have access to this museum.');
  return members[0] as { user_id: string; email: string; role: string };
}
async function body(request: Request) {
  const declared = Number(request.headers.get('Content-Length') ?? 0);
  if (declared > 8 * 1024 * 1024) throw new HttpError(413, 'Request is too large.');
  const text = await request.text();
  if (text.length > 8 * 1024 * 1024) throw new HttpError(413, 'Request is too large.');
  try {
    return JSON.parse(text);
  } catch {
    throw new HttpError(400, 'Request must contain valid JSON.');
  }
}
async function current(env: Env) {
  const item = await env.MUSEUM.get('current.json');
  return item ? { ...(await item.json<{ id: string }>()), etag: item.etag } : null;
}
async function publication(env: Env, id: string) {
  if (!/^[\w-]{1,100}$/.test(id)) throw new HttpError(400, 'Invalid version.');
  const object = await env.MUSEUM.get(`manifests/${id}.json`);
  if (!object) throw new HttpError(404, 'This museum version is unavailable.');
  return object.json<Publication>();
}
async function switchCurrent(env: Env, id: string, previous: string | null) {
  const existing = await current(env);
  if ((existing?.id ?? null) !== previous)
    throw new HttpError(409, 'Another publication changed the museum. Reload before publishing.');
  const written = await env.MUSEUM.put('current.json', JSON.stringify({ id }), {
    onlyIf: existing ? { etagMatches: existing.etag } : { etagDoesNotMatch: '*' },
    httpMetadata: { contentType: 'application/json', cacheControl: 'no-store' },
  });
  if (!written)
    throw new HttpError(
      409,
      'Another publication won the race. Your earlier public version remains available.',
    );
}
async function signed(env: Env, key: string, method: 'PUT' | 'GET', mime?: string) {
  const client = new AwsClient({
    accessKeyId: env.R2_ACCESS_KEY_ID,
    secretAccessKey: env.R2_SECRET_ACCESS_KEY,
    service: 's3',
    region: 'auto',
  });
  const url = new URL(
    `https://${env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com/${env.R2_BUCKET_NAME}/${key}`,
  );
  url.searchParams.set('X-Amz-Expires', '600');
  const req = await client.sign(
    new Request(url, { method, headers: mime ? { 'Content-Type': mime } : {} }),
    { aws: { signQuery: true } },
  );
  return req.url;
}
function mediaResponse(object: R2ObjectBody, download?: string) {
  const headers = new Headers();
  object.writeHttpMetadata(headers);
  headers.set('ETag', object.httpEtag);
  headers.set('X-Content-Type-Options', 'nosniff');
  headers.set('Content-Security-Policy', "default-src 'none'; sandbox");
  headers.set(
    'Cache-Control',
    download ? 'private, no-store' : 'public, max-age=31536000, immutable',
  );
  if (download)
    headers.set(
      'Content-Disposition',
      `attachment; filename*=UTF-8''${encodeURIComponent(download)}`,
    );
  return new Response(object.body, { headers });
}
async function validateAssets(env: Env, doc: MuseumDocument) {
  const records = await db(env, 'museum_assets?ready=eq.true&select=id,asset');
  const uploaded = new Map(records.map((r: any) => [r.id, r.asset]));
  const builtins = new Map(sample.assets.map((a) => [a.id, a]));
  for (const a of doc.assets) {
    const builtin = builtins.get(a.id);
    if (
      builtin &&
      a.source === builtin.source &&
      JSON.stringify(a.variants) === JSON.stringify(builtin.variants) &&
      a.width === builtin.width &&
      a.height === builtin.height
    )
      continue;
    const trusted = uploaded.get(a.id) as Asset | undefined;
    if (
      !trusted ||
      a.source !== trusted.source ||
      JSON.stringify(a.variants) !== JSON.stringify(trusted.variants) ||
      a.width !== trusted.width ||
      a.height !== trusted.height ||
      a.bytes !== trusted.bytes ||
      a.mime !== trusted.mime
    )
      throw new HttpError(422, `Image ${a.title} is not a completed upload.`);
  }
}
export async function handle(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url),
    path = url.pathname,
    method = request.method;
  if (!path.startsWith('/api/')) return env.ASSETS.fetch(request);
  if (method === 'GET' && path === '/api/current') {
    const pointer = await current(env);
    if (!pointer) throw new HttpError(404, 'The curator has not published a museum yet.');
    const p = await publication(env, pointer.id);
    return json({ id: p.id, document: p.document });
  }
  if (method === 'GET' && path.startsWith('/api/versions/')) {
    const p = await publication(env, path.slice('/api/versions/'.length));
    return json({ id: p.id, document: p.document }, 200, {
      'Cache-Control': 'public, max-age=31536000, immutable',
    });
  }
  if (method === 'GET' && path.startsWith('/api/media/')) {
    const key = decodeURIComponent(path.slice('/api/media/'.length));
    if (!/^published\/[\w-]+\/variants\/[\w-]+\/(512|1024|2048)$/.test(key))
      throw new HttpError(404, 'Image unavailable.');
    const object = await (env.DISPLAY ?? env.MUSEUM).get(key);
    if (!object) throw new HttpError(404, 'Image unavailable.');
    return mediaResponse(object);
  }
  if (method === 'GET' && path.startsWith('/api/download/')) {
    const parts = path.split('/');
    if (parts.length !== 5) throw new HttpError(404, 'Download unavailable.');
    const p = await publication(env, parts[3]),
      a = p.document.assets.find((a) => a.id === parts[4]);
    if (
      !a?.downloadable ||
      !p.document.rooms.some((r) => r.kind === 'shop') ||
      !p.document.regions.some((r) => r.assetId === a.id)
    )
      throw new HttpError(403, 'This artwork is not available for download.');
    if (a.source.startsWith('/art/')) {
      const response = await env.ASSETS.fetch(new Request(new URL(a.source, request.url)));
      const headers = new Headers(response.headers);
      headers.set(
        'Content-Disposition',
        `attachment; filename*=UTF-8''${encodeURIComponent(a.title + '.svg')}`,
      );
      headers.set('Cache-Control', 'private, no-store');
      return new Response(response.body, { status: response.status, headers });
    }
    const object = await env.MUSEUM.get(a.source);
    if (!object) throw new HttpError(404, 'Original unavailable.');
    return mediaResponse(object, a.title + '.' + a.mime.split('/')[1]);
  }
  const user = await identity(request, env);
  if (
    !['GET', 'HEAD'].includes(method) &&
    request.headers.get('Origin') &&
    request.headers.get('Origin') !== env.APP_ORIGIN
  )
    throw new HttpError(403, 'Request origin is not allowed.');
  if (path === '/api/draft' && method === 'GET') {
    let rows = await db(env, 'museum_drafts?id=eq.true&select=*');
    if (!rows.length) {
      await db(env, 'museum_drafts', {
        method: 'POST',
        headers: { Prefer: 'resolution=ignore-duplicates,return=representation' },
        body: JSON.stringify({ id: true, document: sample, revision: 0 }),
      });
      rows = await db(env, 'museum_drafts?id=eq.true&select=*');
    }
    return json({ ...rows[0], publication: (await current(env))?.id ?? null });
  }
  if (path === '/api/draft' && method === 'PUT') {
    const input = z
      .object({ document: museumSchema, revision: z.number().int().nonnegative() })
      .parse(await body(request));
    await validateAssets(env, input.document);
    const rows = await db(env, `museum_drafts?id=eq.true&revision=eq.${input.revision}`, {
      method: 'PATCH',
      body: JSON.stringify({
        document: input.document,
        revision: input.revision + 1,
        updated_by: user.user_id,
        updated_at: new Date().toISOString(),
      }),
    });
    if (!rows.length)
      throw new HttpError(
        409,
        'Another editor saved changes. Export your work before reloading the saved draft.',
      );
    return json({ ...rows[0], publication: (await current(env))?.id ?? null });
  }
  if (path === '/api/publish' && method === 'POST') {
    const input = z
        .object({ revision: z.number().int().nonnegative(), previous: z.string().nullable() })
        .parse(await body(request)),
      drafts = await db(env, 'museum_drafts?id=eq.true&select=*'),
      draft = drafts[0] as Draft | undefined;
    if (!draft || draft.revision !== input.revision)
      throw new HttpError(409, 'Draft changed. Save and review it before publishing.');
    const document = museumSchema.parse(draft.document),
      issues = compile(document).issues;
    if (issues.length) throw new HttpError(422, issues.map((i) => i.message).join(' '));
    await validateAssets(env, document);
    if ((await current(env))?.id !== input.previous && input.previous !== null)
      throw new HttpError(409, 'Publication changed. Reload before publishing.');
    const id = crypto.randomUUID();
    await env.MUSEUM.put(
      'jobs/' + id + '.json',
      JSON.stringify({
        id,
        document: publicDocument(document),
        previous: input.previous,
        cursor: 0,
        createdAt: new Date().toISOString(),
      }),
    );
    return json({ id, done: false, cursor: 0 });
  }
  if (/^\/api\/publish\/[\w-]+\/step$/.test(path) && method === 'POST') {
    const id = path.split('/')[3],
      stored = await env.MUSEUM.get('jobs/' + id + '.json');
    if (!stored) throw new HttpError(404, 'Publication job unavailable.');
    const job = await stored.json<{
      id: string;
      document: MuseumDocument;
      previous: string | null;
      cursor: number;
      createdAt: string;
    }>();
    const input = z.object({ cursor: z.number().int().nonnegative() }).parse(await body(request));
    if (input.cursor !== job.cursor)
      throw new HttpError(409, 'Publication progress changed. Retry the publication.');
    const end = Math.min(job.cursor + 4, job.document.assets.length);
    for (const a of job.document.assets.slice(job.cursor, end)) {
      if (a.source.startsWith('/art/')) continue;
      for (const size of ['original', '512', '1024', '2048']) {
        const source = size === 'original' ? a.source : a.variants[size],
          object = await env.MUSEUM.get(source);
        if (!object)
          throw new HttpError(422, 'An image is missing. Upload it again before publishing.');
        const dest =
          'published/' +
          id +
          '/' +
          (size === 'original' ? 'originals/' + a.id : 'variants/' + a.id + '/' + size);
        await (size === 'original' ? env.MUSEUM : (env.DISPLAY ?? env.MUSEUM)).put(
          dest,
          object.body,
          { onlyIf: { etagDoesNotMatch: '*' }, httpMetadata: object.httpMetadata },
        );
      }
    }
    if (end < job.document.assets.length) {
      const updated = await env.MUSEUM.put(
        'jobs/' + id + '.json',
        JSON.stringify({ ...job, cursor: end }),
        { onlyIf: { etagMatches: stored.etag } },
      );
      if (!updated) throw new HttpError(409, 'Publication progress changed.');
      return json({ id, done: false, cursor: end });
    }
    const published = structuredClone(job.document);
    for (const a of published.assets) {
      if (a.source.startsWith('/art/')) continue;
      a.source = 'published/' + id + '/originals/' + a.id;
      for (const size of ['512', '1024', '2048'])
        a.variants[size] = 'published/' + id + '/variants/' + a.id + '/' + size;
    }
    const result: Publication = {
      id,
      name: published.name,
      createdAt: job.createdAt,
      document: published,
    };
    await env.MUSEUM.put('manifests/' + id + '.json', JSON.stringify(result), {
      onlyIf: { etagDoesNotMatch: '*' },
      httpMetadata: {
        contentType: 'application/json',
        cacheControl: 'public, max-age=31536000, immutable',
      },
    });
    await switchCurrent(env, id, job.previous);
    await env.MUSEUM.delete('jobs/' + id + '.json');
    return json({ id, done: true, cursor: end });
  }
  if (path === '/api/versions' && method === 'GET') {
    const all = [];
    let cursor: string | undefined;
    do {
      const list = await env.MUSEUM.list({ prefix: 'manifests/', cursor, limit: 100 });
      for (const obj of list.objects)
        all.push({
          id: obj.key.slice(10, -5),
          name: 'Museum publication',
          createdAt: obj.uploaded.toISOString(),
        });
      cursor = list.truncated ? list.cursor : undefined;
    } while (cursor);
    return json(all.sort((a, b) => b.createdAt.localeCompare(a.createdAt)));
  }
  if (path === '/api/rollback' && method === 'POST') {
    const input = z
      .object({ id: z.string(), previous: z.string().nullable() })
      .parse(await body(request));
    await publication(env, input.id);
    await switchCurrent(env, input.id, input.previous);
    return json({ id: input.id });
  }
  if (path === '/api/uploads' && method === 'POST') {
    const input = z
        .object({
          asset: assetSchema,
          files: z
            .array(
              z.object({
                key: z.string(),
                bytes: z
                  .number()
                  .int()
                  .positive()
                  .max(25 * 1024 * 1024),
                mime: z.enum(['image/jpeg', 'image/png', 'image/webp']),
              }),
            )
            .length(4),
        })
        .parse(await body(request)),
      a = input.asset;
    if (a.width * a.height > 40_000_000 || a.ready)
      throw new HttpError(422, 'Invalid image dimensions or upload state.');
    const expected = [
      `originals/${a.id}`,
      `variants/${a.id}/512`,
      `variants/${a.id}/1024`,
      `variants/${a.id}/2048`,
    ];
    if (
      a.source !== expected[0] ||
      ['512', '1024', '2048'].some((size, i) => a.variants[size] !== expected[i + 1]) ||
      input.files.some((f, i) => f.key !== expected[i]) ||
      input.files[0].bytes !== a.bytes ||
      input.files[0].mime !== a.mime
    )
      throw new HttpError(422, 'Invalid upload keys or file metadata.');
    const existing = await db(env, `museum_assets?id=eq.${a.id}&select=id`);
    if (existing.length)
      throw new HttpError(409, 'Upload already exists. Retry with a new image upload.');
    await db(env, 'museum_assets', {
      method: 'POST',
      body: JSON.stringify({
        id: a.id,
        asset: a,
        files: input.files,
        ready: false,
        created_by: user.user_id,
      }),
    });
    const uploads = [];
    for (const f of input.files)
      uploads.push({ key: f.key, url: await signed(env, 'staging/' + f.key, 'PUT', f.mime) });
    return json({ uploads });
  }
  if (path === '/api/uploads/complete' && method === 'POST') {
    const input = z.object({ id: z.string().uuid() }).parse(await body(request)),
      records = await db(env, `museum_assets?id=eq.${input.id}&select=*`),
      record = records[0];
    if (!record) throw new HttpError(404, 'Upload not found.');
    if (record.ready) return json({ ready: true });
    for (const file of record.files) {
      const meta = await env.MUSEUM.head('staging/' + file.key);
      if (!meta || meta.size !== file.bytes || meta.httpMetadata?.contentType !== file.mime)
        throw new HttpError(
          422,
          'An upload is incomplete or does not match its declared size/type.',
        );
      const object = await env.MUSEUM.get('staging/' + file.key, {
        range: { offset: 0, length: Math.min(meta.size, 262144) },
        onlyIf: { etagMatches: meta.etag },
      });
      if (!object || !('body' in object))
        throw new HttpError(409, 'Upload changed during validation. Retry.');
      const bytes = new Uint8Array(await object!.arrayBuffer()),
        dims = imageDimensions(bytes, file.mime);
      if (!imageMagic(bytes, file.mime) || !dims || dims.width * dims.height > 40_000_000)
        throw new HttpError(422, 'Uploaded content has invalid image dimensions or format.');
      const a = record.asset as Asset,
        size = file.key.split('/').at(-1);
      if (size === a.id) {
        if (!(
          (dims.width === a.width && dims.height === a.height) ||
          (dims.height === a.width && dims.width === a.height)
        ))
          throw new HttpError(422, 'Original image dimensions do not match.');
      } else {
        const scale = Math.min(1, Number(size) / Math.max(a.width, a.height));
        if (
          dims.width !== Math.round(a.width * scale) ||
          dims.height !== Math.round(a.height * scale)
        )
          throw new HttpError(422, 'Display variant does not preserve the original proportions.');
      }
      // Re-read conditionally: a still-valid upload URL cannot swap bytes between validation and freezing.
      const frozen = await env.MUSEUM.get('staging/' + file.key, {
        onlyIf: { etagMatches: meta.etag },
      });
      if (!frozen || !('body' in frozen))
        throw new HttpError(409, 'Upload changed during validation. Retry.');
      await env.MUSEUM.put(file.key, frozen.body, {
        onlyIf: { etagDoesNotMatch: '*' },
        httpMetadata: frozen.httpMetadata,
      });
    }
    await db(env, `museum_assets?id=eq.${input.id}`, {
      method: 'PATCH',
      body: JSON.stringify({ ready: true, asset: { ...record.asset, ready: true } }),
    });
    return json({ ready: true });
  }
  if (path === '/api/media-url' && method === 'GET') {
    const key = url.searchParams.get('key') ?? '';
    if (!/^(variants\/[\w-]+\/(512|1024|2048)|originals\/[\w-]+)$/.test(key))
      throw new HttpError(400, 'Invalid image key.');
    const records = await db(
      env,
      `museum_assets?id=eq.${key.split('/')[1]}&ready=eq.true&select=id`,
    );
    if (!records.length) throw new HttpError(404, 'Image unavailable.');
    return json({ url: await signed(env, key, 'GET') });
  }
  if (path === '/api/usage' && method === 'GET') {
    let bytes = 0,
      objects = 0;
    for (const bucket of [env.MUSEUM, ...(env.DISPLAY ? [env.DISPLAY] : [])]) {
      let cursor: string | undefined;
      do {
        const list = await bucket.list({ cursor, limit: 1000 });
        for (const o of list.objects) {
          bytes += o.size;
          objects++;
        }
        cursor = list.truncated ? list.cursor : undefined;
      } while (cursor);
    }
    return json({ bytes, objects });
  }
  if (path.startsWith('/api/members')) {
    if (user.role !== 'owner')
      throw new HttpError(403, 'Only the museum owner can manage editors.');
    if (method === 'GET' && path === '/api/members')
      return json(await db(env, 'museum_members?select=user_id,email,role'));
    if (method === 'POST' && path === '/api/members') {
      const input = z.object({ email: z.string().email().max(254) }).parse(await body(request));
      const response = await fetch(
        `${env.SUPABASE_URL}/auth/v1/invite?redirect_to=${encodeURIComponent(env.APP_ORIGIN + '/admin')}`,
        {
          method: 'POST',
          headers: {
            apikey: env.SUPABASE_SERVICE_ROLE_KEY,
            Authorization: `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({ email: input.email }),
        },
      );
      if (!response.ok)
        throw new HttpError(
          400,
          'Invitation failed. Check the email address and Supabase email configuration.',
        );
      const invited = (await response.json()) as { id: string };
      await db(env, 'museum_members', {
        method: 'POST',
        body: JSON.stringify({ user_id: invited.id, email: input.email, role: 'editor' }),
      });
      return json({ invited: true });
    }
    if (method === 'DELETE') {
      const id = z.string().uuid().parse(path.slice('/api/members/'.length));
      const deleted = await db(env, `museum_members?user_id=eq.${id}&role=eq.editor`, {
        method: 'DELETE',
      });
      if (!deleted?.length)
        throw new HttpError(404, 'Editor not found. The owner cannot be revoked.');
      return json({ revoked: true });
    }
  }
  throw new HttpError(404, 'Endpoint not found.');
}
export function imageMagic(bytes: Uint8Array, mime: string) {
  if (mime === 'image/png')
    return [137, 80, 78, 71, 13, 10, 26, 10].every((v, i) => bytes[i] === v);
  if (mime === 'image/jpeg') return bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255;
  return (
    new TextDecoder().decode(bytes.slice(0, 4)) === 'RIFF' &&
    new TextDecoder().decode(bytes.slice(8, 12)) === 'WEBP'
  );
}
export default {
  async fetch(request: Request, env: Env) {
    try {
      return await handle(request, env);
    } catch (e) {
      if (e instanceof z.ZodError)
        return json({ error: 'Invalid museum data.', issues: e.issues }, 422);
      if (e instanceof HttpError) return json({ error: e.message }, e.status);
      console.error('Request failed', e instanceof Error ? e.message : 'Unknown error');
      return json({ error: 'The request failed. Your current publication is unchanged.' }, 500);
    }
  },
} satisfies ExportedHandler<Env>;
