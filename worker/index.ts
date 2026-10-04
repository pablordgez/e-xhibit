import { AwsClient } from 'aws4fetch';
import { z } from 'zod';
import { museumSchema, assetSchema, type MuseumDocument, type Asset } from '../src/core/model';
import { compile } from '../src/core/layout';
import { sample } from '../src/core/sample';
import { publicDocument } from '../src/core/publication';
import { imageDimensions } from '../src/core/imageMetadata';
import { HttpError, body } from './http';
import {
  resources,
  reserve,
  reserveRevalidation,
  reservation,
  settle,
  completeUpload,
} from './resources';
import { uploadLimits, receiveOriginal } from './uploads';
import { trustedVariants, validatedFiles } from './imageValidation';
import { workQueue } from './workQueue';
const heavyWork = workQueue(1),
  transfers = workQueue(2),
  policyReads = workQueue(1);
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
  IMAGES?: ImagesBinding;
  AUTH_LIMITER: RateLimit;
  CREATE_LIMITER: RateLimit;
  MAX_STORAGE_BYTES?: string;
  MAX_UPLOAD_BYTES?: string;
  MAX_IMAGE_PIXELS?: string;
  LEGACY_ASSET_ORIGIN?: string;
}
type Publication = { id: string; name: string; createdAt: string; document: MuseumDocument };
type Draft = { id: boolean; revision: number; document: MuseumDocument };
const json = (data: unknown, status = 200, headers: HeadersInit = {}) =>
  Response.json(data, {
    status,
    headers: { 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', ...headers },
  });
function serviceHeaders(env: Env): Record<string, string> {
  const key = env.SUPABASE_SERVICE_ROLE_KEY;
  return {
    apikey: key,
    // New secret keys authenticate through the API gateway; only legacy keys are JWTs.
    ...(!key.startsWith('sb_secret_') ? { Authorization: `Bearer ${key}` } : {}),
  };
}
async function db(env: Env, path: string, init: RequestInit = {}) {
  const r = await fetch(`${env.SUPABASE_URL}/rest/v1/${path}`, {
    ...init,
    headers: {
      ...serviceHeaders(env),
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
async function current(env: Env) {
  const item = await env.MUSEUM.get('current.json');
  return item
    ? { ...(await item.json<{ id: string; committed?: string[] }>()), etag: item.etag }
    : null;
}
async function committed(env: Env, id: string) {
  const pointer = await current(env);
  return Boolean(pointer && (pointer.committed ?? [pointer.id]).includes(id));
}
async function publicationObject(env: Env, id: string) {
  if (!/^[\w-]{1,100}$/.test(id)) throw new HttpError(400, 'Invalid version.');
  if (!(await committed(env, id))) throw new HttpError(404, 'This museum version is unavailable.');
  const object = await env.MUSEUM.get(`manifests/${id}.json`);
  if (!object) throw new HttpError(404, 'This museum version is unavailable.');
  return object;
}
async function publication(env: Env, id: string) {
  return (await publicationObject(env, id)).json<Publication>();
}
type MediaPolicy = {
  variants: Set<string>;
  downloads: Map<string, Pick<Asset, 'id' | 'title' | 'source' | 'mime'>>;
};
const policyCaches = new WeakMap<
  R2Bucket,
  Map<string, { done: boolean; value: Promise<MediaPolicy> }>
>();
async function mediaPolicy(env: Env, id: string) {
  if (!/^[\w-]{1,100}$/.test(id)) throw new HttpError(400, 'Invalid version.');
  if (!(await committed(env, id))) throw new HttpError(404, 'This museum version is unavailable.');
  const cache = policyCaches.get(env.MUSEUM) ?? new Map();
  policyCaches.set(env.MUSEUM, cache);
  if (!cache.has(id)) {
    const entry = {
      done: false,
      value: (async () => {
        const release = await policyReads();
        try {
          const p = await publication(env, id),
            displayed = new Set(p.document.regions.map((region) => region.assetId));
          const shop = p.document.rooms.some((room) => room.kind === 'shop');
          const policy: MediaPolicy = { variants: new Set(), downloads: new Map() };
          for (const asset of p.document.assets) {
            for (const size of ['512', '1024', '2048'])
              if (asset.variants[size]) policy.variants.add(asset.variants[size]);
            if (shop && displayed.has(asset.id) && asset.downloadable)
              policy.downloads.set(asset.id, {
                id: asset.id,
                title: asset.title,
                source: asset.source,
                mime: asset.mime,
              });
          }
          return policy;
        } finally {
          release();
        }
      })(),
    };
    cache.set(id, entry);
    void entry.value.then(
      () => {
        entry.done = true;
        for (const [key, value] of cache) if (cache.size > 16 && value.done) cache.delete(key);
      },
      () => cache.delete(id),
    );
  }
  return cache.get(id)!.value;
}
function manifestResponse(object: R2ObjectBody, immutable = false) {
  return new Response(object.body, {
    headers: {
      'Content-Type': 'application/json',
      'X-Content-Type-Options': 'nosniff',
      'Cache-Control': immutable ? 'public, max-age=31536000, immutable' : 'no-store',
    },
  });
}
async function switchCurrent(env: Env, id: string, previous: string | null) {
  const existing = await current(env);
  if (existing?.id === id) return; // A committed step is safe to retry after cleanup failed.
  if ((existing?.id ?? null) !== previous)
    throw new HttpError(409, 'Another publication changed the museum. Reload before publishing.');
  const versions = [...new Set([...(existing?.committed ?? (existing ? [existing.id] : [])), id])];
  if (versions.length > 1000) throw new HttpError(409, 'Publication retention limit reached.');
  const written = await env.MUSEUM.put(
    'current.json',
    JSON.stringify({ id, committed: versions }),
    {
      onlyIf: existing ? { etagMatches: existing.etag } : { etagDoesNotMatch: '*' },
      httpMetadata: { contentType: 'application/json', cacheControl: 'no-store' },
    },
  );
  if (!written)
    throw new HttpError(
      409,
      'Another publication won the race. Your earlier public version remains available.',
    );
}
function signingClient(env: Env) {
  return new AwsClient({
    accessKeyId: env.R2_ACCESS_KEY_ID,
    secretAccessKey: env.R2_SECRET_ACCESS_KEY,
    service: 's3',
    region: 'auto',
  });
}
async function signed(env: Env, key: string, client = signingClient(env)) {
  const url = new URL(
    `https://${env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com/${env.R2_BUCKET_NAME}/${key}`,
  );
  url.searchParams.set('X-Amz-Expires', '300');
  const req = await client.sign(new Request(url, { method: 'GET' }), { aws: { signQuery: true } });
  return req.url;
}
function mediaResponse(object: R2ObjectBody, download?: string) {
  const headers = new Headers();
  headers.set(
    'Content-Type',
    download ? (object.httpMetadata?.contentType ?? 'application/octet-stream') : 'image/webp',
  );
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
async function validateAssets(env: Env, doc: MuseumDocument, requireDecoded = true) {
  const builtins = new Map(sample.assets.map((a) => [a.id, a]));
  const uploaded = new Map<string, Asset>();
  const storedSizes = new Map<string, number>();
  const ids = [...new Set(doc.assets.filter((a) => !builtins.has(a.id)).map((a) => a.id))];
  for (let start = 0; start < ids.length; start += 50) {
    const group = ids.slice(start, start + 50);
    for (let offset = 0; offset < group.length;) {
      const rows = await db(
        env,
        `museum_assets?ready=eq.true&id=in.(${group.join(',')})&select=id,asset,files&order=id.asc&limit=50&offset=${offset}`,
      );
      if (!rows.length) break;
      for (const r of rows)
        if (
          (validatedFiles(r.files) || !requireDecoded) &&
          r.asset?.source === `originals/${r.id}` &&
          Object.keys(r.asset.variants ?? {}).length === 3 &&
          ['512', '1024', '2048'].every(
            (size) => r.asset.variants[size] === `variants/${r.id}/${size}`,
          )
        ) {
          uploaded.set(r.id, r.asset);
          const size = (r.files ?? []).reduce((sum: number, f: any) => sum + f.bytes, 0);
          storedSizes.set(
            r.id,
            Number.isSafeInteger(size) && size > 0 ? size : r.asset.bytes + 27_000_000,
          );
        }
      offset += rows.length;
    }
  }
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
  return storedSizes;
}
export async function handle(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url),
    path = url.pathname,
    method = request.method;
  if (env.LEGACY_ASSET_ORIGIN && url.origin === new URL(env.LEGACY_ASSET_ORIGIN).origin) {
    if (url.origin === new URL(env.APP_ORIGIN).origin)
      throw new HttpError(503, 'The legacy asset origin must differ from the application origin.');
    if (!['GET', 'HEAD'].includes(method) || !path.startsWith('/published/'))
      throw new HttpError(404, 'Image unavailable.');
    const target = new URL('/api/media/' + encodeURIComponent(path.slice(1)), env.APP_ORIGIN);
    const response = await handle(new Request(target, { method: 'GET' }), env);
    const headers = new Headers(response.headers);
    headers.set('Access-Control-Allow-Origin', env.APP_ORIGIN);
    return new Response(method === 'HEAD' ? null : response.body, {
      status: response.status,
      headers,
    });
  }
  if (!path.startsWith('/api/')) return env.ASSETS.fetch(request);
  if (method === 'GET' && path === '/api/limits')
    return json(uploadLimits(env), 200, { 'Cache-Control': 'public, max-age=60' });
  if (method === 'GET' && path === '/api/current') {
    const pointer = await current(env);
    if (!pointer) throw new HttpError(404, 'The curator has not published a museum yet.');
    return manifestResponse(await publicationObject(env, pointer.id));
  }
  if (method === 'GET' && path.startsWith('/api/versions/')) {
    return manifestResponse(
      await publicationObject(env, path.slice('/api/versions/'.length)),
      true,
    );
  }
  if (method === 'GET' && path.startsWith('/api/media/')) {
    let key: string;
    try {
      key = decodeURIComponent(path.slice('/api/media/'.length));
    } catch {
      throw new HttpError(400, 'Invalid image key.');
    }
    if (!/^published\/[\w-]+\/variants\/[\w-]+\/(512|1024|2048)$/.test(key))
      throw new HttpError(404, 'Image unavailable.');
    const policy = await mediaPolicy(env, key.split('/')[1]);
    if (!policy.variants.has(key)) throw new HttpError(404, 'Image unavailable.');
    const object = (await env.MUSEUM.get(key)) ?? (await env.DISPLAY?.get(key));
    if (!object) throw new HttpError(404, 'Image unavailable.');
    return mediaResponse(object);
  }
  if (method === 'GET' && path.startsWith('/api/download/')) {
    const parts = path.split('/');
    if (parts.length !== 5) throw new HttpError(404, 'Download unavailable.');
    const a = (await mediaPolicy(env, parts[3])).downloads.get(parts[4]);
    if (!a) throw new HttpError(403, 'This artwork is not available for download.');
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
  const routes = [
    ['^/api/draft$', 'GET|PUT'],
    ['^/api/publish$', 'POST'],
    ['^/api/publish/[\\w-]+/step$', 'POST'],
    ['^/api/versions$', 'GET'],
    ['^/api/versions/import$', 'POST'],
    ['^/api/rollback$', 'POST'],
    ['^/api/uploads$', 'POST'],
    ['^/api/uploads/(complete|revalidate)$', 'POST'],
    ['^/api/uploads/[\\w-]+/(file|master)$', 'PUT'],
    ['^/api/asset-status$', 'GET'],
    ['^/api/media-url$', 'GET'],
    ['^/api/media-urls$', 'GET'],
    ['^/api/usage$', 'GET'],
    ['^/api/members$', 'GET|POST'],
    ['^/api/members/[\\w-]+$', 'DELETE'],
  ];
  if (
    !routes.some(
      ([pattern, methods]) => new RegExp(pattern).test(path) && methods.split('|').includes(method),
    )
  )
    throw new HttpError(404, 'Endpoint not found.');
  if (
    !(await env.AUTH_LIMITER.limit({ key: request.headers.get('CF-Connecting-IP') ?? 'local' }))
      .success
  )
    throw new HttpError(429, 'Too many requests. Try again shortly.');
  const user = await identity(request, env);
  const mutation =
    !['GET', 'HEAD'].includes(method) ||
    (path === '/api/asset-status' && url.searchParams.get('check-files') === '1');
  if (mutation) {
    if (!(await env.CREATE_LIMITER.limit({ key: user.user_id })).success)
      throw new HttpError(429, 'Too many editing requests. Try again shortly.');
  } else if (!(await env.AUTH_LIMITER.limit({ key: `member-read:${user.user_id}` })).success) {
    throw new HttpError(429, 'Too many image or studio reads. Try again shortly.');
  }
  if (
    !['GET', 'HEAD'].includes(method) &&
    request.headers.get('Origin') &&
    request.headers.get('Origin') !== env.APP_ORIGIN
  )
    throw new HttpError(403, 'Request origin is not allowed.');
  const heavy =
    path === '/api/draft' ||
    path === '/api/rollback' ||
    path === '/api/versions/import' ||
    path.startsWith('/api/publish') ||
    /^\/api\/uploads\/(complete|revalidate)$/.test(path) ||
    (path === '/api/asset-status' && url.searchParams.get('check-files') === '1');
  const release = heavy
    ? await heavyWork()
    : /^\/api\/uploads\/[\w-]+\/(file|master)$/.test(path)
      ? await transfers()
      : () => {};
  try {
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
        .parse(await body(request, 8 * 1024 * 1024));
      // Private metadata edits may retain registered legacy images. Publication
      // still requires full server decoding; saving must not depend on that work.
      await validateAssets(env, input.document, false);
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
      const sizes = await validateAssets(env, document);
      if (((await current(env))?.id ?? null) !== input.previous)
        throw new HttpError(409, 'Publication changed. Reload before publishing.');
      const id = crypto.randomUUID();
      let allocation = new TextEncoder().encode(JSON.stringify(document)).length * 2 + 65536;
      for (const a of publicDocument(document).assets)
        if (!a.source.startsWith('/art/')) allocation += sizes.get(a.id) ?? a.bytes + 27_000_000;
      const budget = await reserve(env, 'jobs', id, user.user_id, allocation);
      await env.MUSEUM.put(
        'jobs/' + id + '.json',
        JSON.stringify({
          id,
          document: publicDocument(document),
          previous: input.previous,
          cursor: 0,
          createdAt: new Date().toISOString(),
          expires: budget.expires,
        }),
      );
      return json({ id, done: false, cursor: 0 });
    }
    if (/^\/api\/publish\/[\w-]+\/step$/.test(path) && method === 'POST') {
      const id = path.split('/')[3],
        stored = await env.MUSEUM.get('jobs/' + id + '.json');
      if (!stored) throw new HttpError(404, 'Publication job unavailable.');
      await reservation(env, 'jobs', id);
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
          await env.MUSEUM.put(dest, object.body, {
            onlyIf: { etagDoesNotMatch: '*' },
            httpMetadata: {
              contentType: size === 'original' ? a.mime : 'image/webp',
              cacheControl: 'no-store',
              ...(size === 'original' ? { contentDisposition: 'attachment' } : {}),
            },
          });
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
        customMetadata: { name: published.name, createdAt: job.createdAt },
        httpMetadata: {
          contentType: 'application/json',
          cacheControl: 'public, max-age=31536000, immutable',
        },
      });
      await switchCurrent(env, id, job.previous);
      // Never report a failed publication after the atomic commit succeeded.
      try {
        await env.MUSEUM.delete('jobs/' + id + '.json');
        await settle(env, 'jobs', id, (await reservation(env, 'jobs', id)).bytes);
      } catch {
        console.error('Committed publication cleanup will retry on schedule.');
      }
      return json({ id, done: true, cursor: end });
    }
    if (path === '/api/versions' && method === 'GET') {
      const pointer = await current(env),
        offset = z.coerce
          .number()
          .int()
          .min(0)
          .max(1000)
          .parse(url.searchParams.get('offset') ?? 0);
      const ids = (pointer?.committed ?? (pointer ? [pointer.id] : []))
        .slice()
        .reverse()
        .slice(offset, offset + 20);
      return json(
        await Promise.all(
          ids.map(async (id) => {
            const p = await env.MUSEUM.head(`manifests/${id}.json`);
            return {
              id,
              name: p?.customMetadata?.name ?? 'Museum publication',
              createdAt: p?.customMetadata?.createdAt ?? p?.uploaded.toISOString() ?? '',
            };
          }),
        ),
      );
    }
    if (path === '/api/rollback' && method === 'POST') {
      const input = z
        .object({ id: z.string(), previous: z.string().nullable() })
        .parse(await body(request));
      await publication(env, input.id);
      await switchCurrent(env, input.id, input.previous);
      return json({ id: input.id });
    }
    if (path === '/api/versions/import' && method === 'POST') {
      if (user.role !== 'owner')
        throw new HttpError(403, 'Only the owner can approve legacy publications.');
      const input = z
        .object({
          ids: z.array(z.string().regex(/^[\w-]{1,100}$/)).max(20),
          previous: z.string().nullable(),
        })
        .parse(await body(request));
      const pointer = await current(env);
      if (!pointer || pointer.id !== input.previous)
        throw new HttpError(409, 'Publication changed. Reload before importing history.');
      for (const id of input.ids) {
        const object = await env.MUSEUM.get(`manifests/${id}.json`);
        if (!object) throw new HttpError(404, 'Legacy manifest unavailable.');
        const p = await object.json<Publication>();
        if (p.id !== id) throw new HttpError(422, 'Invalid legacy manifest.');
        museumSchema.parse(p.document);
      }
      const ids = [...new Set([...(pointer.committed ?? [pointer.id]), ...input.ids])];
      if (ids.length > 1000) throw new HttpError(409, 'Publication retention limit reached.');
      const written = await env.MUSEUM.put(
        'current.json',
        JSON.stringify({ id: pointer.id, committed: ids }),
        {
          onlyIf: { etagMatches: pointer.etag },
          httpMetadata: { contentType: 'application/json', cacheControl: 'no-store' },
        },
      );
      if (!written) throw new HttpError(409, 'Publication changed. Retry the import.');
      return json({ imported: true });
    }
    if (path === '/api/uploads' && method === 'POST') {
      const limits = uploadLimits(env);
      const input = z
          .object({
            asset: assetSchema,
            files: z
              .array(
                z.object({
                  key: z.string(),
                  bytes: z.number().int().positive().max(Math.max(limits.bytes, 9_000_000)),
                  mime: z.enum(['image/jpeg', 'image/png', 'image/webp']),
                }),
              )
              .min(1)
              .max(2),
          })
          .parse(await body(request)),
        a = input.asset;
      z.string().uuid().parse(a.id);
      const original = `originals/${a.id}`;
      if (
        a.width * a.height > limits.pixels ||
        a.bytes > limits.bytes ||
        a.ready ||
        a.source !== original ||
        ['512', '1024', '2048'].some((size) => a.variants[size] !== `variants/${a.id}/${size}`) ||
        Object.keys(a.variants).length !== 3 ||
        input.files[0].key !== original ||
        input.files[0].bytes !== a.bytes ||
        input.files[0].mime !== a.mime ||
        (input.files[1] &&
          (input.files[1].key !== `masters/${a.id}` ||
            input.files[1].mime !== 'image/webp' ||
            input.files[1].bytes > 9_000_000))
      )
        throw new HttpError(422, 'Invalid image dimensions, upload keys or metadata.');
      if ((await db(env, `museum_assets?id=eq.${a.id}&select=id`)).length)
        throw new HttpError(409, 'Upload already exists. Retry with a new image upload.');
      if (a.bytes > 20_000_000 && !input.files[1])
        throw new HttpError(
          503,
          'A display master is required for large originals. Reload the studio and try again.',
        );
      await reserve(
        env,
        'uploads',
        a.id,
        user.user_id,
        a.bytes * 2 + 27_004_096 + (input.files[1]?.bytes ?? 0),
      );
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
      return json({
        uploads: input.files.map((file, index) => ({
          key: file.key,
          url: `/api/uploads/${a.id}/${index ? 'master' : 'file'}`,
        })),
      });
    }
    if (/^\/api\/uploads\/[\w-]+\/(file|master)$/.test(path) && method === 'PUT') {
      const id = z.string().uuid().parse(path.split('/')[3]);
      const pending = await reservation(env, 'uploads', id);
      if (pending.user !== user.user_id)
        throw new HttpError(403, 'This upload belongs to another editor.');
      const record = (await db(env, `museum_assets?id=eq.${id}&ready=eq.false&select=*`))[0];
      if (!record) throw new HttpError(404, 'Upload unavailable.');
      const master = path.endsWith('/master');
      const file = record.files[master ? 1 : 0];
      if (!file) throw new HttpError(404, 'Upload file unavailable.');
      if (
        request.headers.get('Content-Type') !== file.mime ||
        request.headers.has('Content-Encoding')
      )
        throw new HttpError(422, 'Upload content type does not match.');
      if (Number(request.headers.get('Content-Length') ?? 0) > file.bytes)
        throw new HttpError(413, 'Upload is too large.');
      await receiveOriginal(request, env, id, 'staging/' + file.key, file.bytes, file.mime, master);
      return json({ uploaded: true });
    }
    if (['/api/uploads/complete', '/api/uploads/revalidate'].includes(path) && method === 'POST') {
      const revalidate = path.endsWith('/revalidate');
      const { id } = z.object({ id: z.string().uuid() }).parse(await body(request));
      const record = (await db(env, `museum_assets?id=eq.${id}&select=*`))[0];
      if (!record) throw new HttpError(404, 'Upload not found.');
      if (!revalidate && record.created_by !== user.user_id)
        throw new HttpError(403, 'This upload belongs to another editor.');
      if (record.ready && (!revalidate || validatedFiles(record.files)))
        return json({ ready: true, asset: record.asset });
      if (revalidate) {
        const a = assetSchema.parse(record.asset);
        if (
          !record.ready ||
          a.source !== `originals/${id}` ||
          Object.keys(a.variants).length !== 3 ||
          ['512', '1024', '2048'].some((s) => a.variants[s] !== `variants/${id}/${s}`)
        )
          throw new HttpError(422, 'This legacy asset needs a new upload.');
        await reserveRevalidation(env, id, user.user_id, a.bytes * 2 + 27_004_096);
      }
      await reservation(env, 'uploads', id);
      const file = record.files[0],
        object = await env.MUSEUM.get(revalidate ? record.asset.source : 'staging/' + file.key);
      // Preserve previously accepted original sizes during migration. Originals remain
      // private attachments; only fully decoded server-generated variants render inline.
      if (
        !object ||
        object.size !== file.bytes ||
        object.size > (revalidate ? 500_000_000 : uploadLimits(env).bytes)
      )
        throw new HttpError(422, 'The original upload is incomplete.');
      const header = await env.MUSEUM.get(object.key, {
        range: { offset: 0, length: Math.min(object.size, 262144) },
      });
      const bytes = new Uint8Array(await header!.arrayBuffer()),
        a = record.asset as Asset;
      const dims = imageDimensions(bytes, a.mime);
      if (
        !imageMagic(bytes, a.mime) ||
        !dims ||
        dims.width * dims.height > uploadLimits(env).pixels ||
        !(
          (dims.width === a.width && dims.height === a.height) ||
          (dims.width === a.height && dims.height === a.width)
        )
      )
        throw new HttpError(422, 'Original image dimensions or format do not match.');
      const master = revalidate
        ? await env.MUSEUM.get(a.variants['2048'])
        : !revalidate && record.files[1]
          ? await env.MUSEUM.get('staging/' + record.files[1].key)
          : null;
      if (!revalidate && record.files[1] && (!master || master.size !== record.files[1].bytes))
        throw new HttpError(422, 'The display master upload is incomplete.');
      let variants;
      let usedMaster = Boolean(master);
      try {
        variants = await trustedVariants(env, a, object, master ?? undefined);
      } catch (error) {
        // Existing browser-generated display images avoid camera metadata and
        // decoder limits. If one is damaged, a small original can still recover it.
        if (
          !revalidate ||
          !master ||
          object.size > 20_000_000 ||
          !(error instanceof HttpError) ||
          error.status !== 422
        )
          throw error;
        const freshOriginal = await env.MUSEUM.get(object.key, {
          onlyIf: { etagMatches: object.etag },
        });
        if (!freshOriginal || !('body' in freshOriginal))
          throw new HttpError(409, 'Original changed during processing.');
        variants = await trustedVariants(env, a, freshOriginal);
        usedMaster = false;
      }
      // Only store results after every transformation succeeded. Metadata is set by the server.
      await reservation(env, 'uploads', id);
      const original = await env.MUSEUM.get(object.key, { onlyIf: { etagMatches: object.etag } });
      if (!original || !('body' in original))
        throw new HttpError(409, 'Original changed during processing.');
      const frozen = await env.MUSEUM.put(a.source, original.body, {
        onlyIf: revalidate ? { etagMatches: object.etag } : { etagDoesNotMatch: '*' },
        httpMetadata: {
          contentType: a.mime,
          cacheControl: 'no-store',
          contentDisposition: 'attachment',
        },
      });
      if (revalidate && !frozen) throw new HttpError(409, 'Original changed during processing.');
      for (const variant of variants)
        await env.MUSEUM.put(variant.key, variant.bytes, {
          ...(revalidate ? {} : { onlyIf: { etagDoesNotMatch: '*' } }),
          httpMetadata: { contentType: 'image/webp', cacheControl: 'no-store' },
        });
      const asset = { ...a, ready: true };
      await db(env, `museum_assets?id=eq.${id}`, {
        method: 'PATCH',
        body: JSON.stringify({
          ready: true,
          asset,
          files: [
            { ...file, validation: usedMaster ? 'original-private-v1' : 'images-v1' },
            ...variants.map((v) => ({
              key: v.key,
              bytes: v.bytes.length,
              mime: 'image/webp',
              validation: 'images-v1',
            })),
          ],
        }),
      });
      await completeUpload(
        env,
        id,
        a.bytes * 2 +
          variants.reduce((sum, v) => sum + v.bytes.length, 0) +
          (!revalidate ? (master?.size ?? 0) : 0) +
          4096,
      );
      // The staging object is immutable and retained until expiry, even after completion.
      // It prevents a request already in flight from recreating it after quota settlement.
      return json({ ready: true, asset });
    }
    if (path === '/api/asset-status' && method === 'GET') {
      const checkFiles = url.searchParams.get('check-files') === '1';
      const ids = z
        .array(z.string().uuid())
        // Four private R2 HEADs per asset, plus authentication/database requests.
        .max(checkFiles ? 10 : 50)
        .parse((url.searchParams.get('ids') ?? '').split(',').filter(Boolean));
      if (!ids.length) return json([]);
      const rows = [];
      for (let offset = 0; offset < ids.length;) {
        const page = await db(
          env,
          `museum_assets?id=in.(${ids.join(',')})&select=id,ready,files&order=id.asc&limit=50&offset=${offset}`,
        );
        if (!page.length) break;
        rows.push(...page);
        offset += page.length;
      }
      return json(
        await Promise.all(
          rows.map(async (row: any) => {
            const validated = Boolean(row.ready && validatedFiles(row.files));
            if (!checkFiles) return { id: row.id, validated };
            let filesAvailable = validated;
            if (validated) {
              const expected = [
                `originals/${row.id}`,
                ...['512', '1024', '2048'].map((size) => `variants/${row.id}/${size}`),
              ];
              for (let i = 0; i < expected.length; i++) {
                const file = row.files[i];
                if (file.key !== expected[i]) {
                  filesAvailable = false;
                  break;
                }
                const object = await env.MUSEUM.head(file.key);
                if (!object || object.size !== file.bytes) {
                  filesAvailable = false;
                  break;
                }
              }
            }
            return { id: row.id, validated, filesAvailable };
          }),
        ),
      );
    }
    if (path === '/api/media-urls' && method === 'GET') {
      const keys = [
        ...new Set(
          z
            .array(
              z
                .string()
                .max(150)
                .regex(/^(variants\/[\w-]+\/(512|1024|2048)|originals\/[\w-]+)$/),
            )
            .min(1)
            .max(50)
            .parse((url.searchParams.get('keys') ?? '').split(',')),
        ),
      ];
      const ids = [...new Set(keys.map((key) => key.split('/')[1]))];
      const ready = new Set<string>();
      for (let offset = 0; offset < ids.length;) {
        const rows = await db(
          env,
          `museum_assets?id=in.(${ids.join(',')})&ready=eq.true&select=id&order=id.asc&limit=50&offset=${offset}`,
        );
        if (!rows.length) break;
        rows.forEach((row: any) => ready.add(row.id));
        offset += rows.length;
      }
      const client = signingClient(env);
      return json({
        urls: await Promise.all(
          keys
            .filter((key) => ready.has(key.split('/')[1]))
            .map(async (key) => ({ key, url: await signed(env, key, client) })),
        ),
        expiresIn: 240,
      });
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
      return json({ url: await signed(env, key) });
    }
    if (path === '/api/usage' && method === 'GET') {
      let bytes = 0,
        objects = 0;
      const page = z
        .object({
          bucket: z.coerce
            .number()
            .int()
            .min(0)
            .max(env.DISPLAY ? 1 : 0),
          cursor: z.string().max(2048).optional(),
        })
        .parse({
          bucket: url.searchParams.get('bucket') ?? 0,
          cursor: url.searchParams.get('cursor') ?? undefined,
        });
      const bucket = page.bucket === 0 ? env.MUSEUM : env.DISPLAY!;
      const list = await bucket.list({ cursor: page.cursor, limit: 1000 });
      for (const o of list.objects) {
        bytes += o.size;
        objects++;
      }
      const next = list.truncated
        ? { bucket: page.bucket, cursor: list.cursor }
        : page.bucket === 0 && env.DISPLAY
          ? { bucket: 1 }
          : null;
      return json({ bytes, objects, next });
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
              ...serviceHeaders(env),
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
  } finally {
    release();
  }
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
export async function cleanup(env: Env) {
  const snapshot = await resources(env, (state) => structuredClone(state));
  const cutoff = Date.now() - 24 * 60 * 60 * 1000;
  // The delay also allows outstanding transfers to finish. Conservatively keep allocation
  // charges after deletion, so a delayed write cannot escape the lifetime storage budget.
  for (const [id, item] of Object.entries(snapshot.uploads)
    .filter(([, item]) => item.expires < cutoff)
    .slice(0, 32)) {
    const record = (await db(env, `museum_assets?id=eq.${id}&select=*`))[0];
    await env.MUSEUM.delete(`staging/originals/${id}`);
    await env.MUSEUM.delete(`staging/masters/${id}`);
    for (const suffix of ['', '.master']) {
      const claim = await env.MUSEUM.get(`control/uploads/${id}${suffix}.json`);
      if (claim) {
        const upload = await claim.json<{ key: string; uploadId?: string }>();
        if (upload.uploadId)
          await env.MUSEUM.resumeMultipartUpload(upload.key, upload.uploadId)
            .abort()
            .catch(() =>
              console.error('Multipart cleanup deferred to the staging lifecycle rule.'),
            );
        await env.MUSEUM.delete(`control/uploads/${id}${suffix}.json`);
      }
    }
    if (!record?.ready) {
      await env.MUSEUM.delete([
        `originals/${id}`,
        ...['512', '1024', '2048'].map((s) => `variants/${id}/${s}`),
      ]);
      await db(env, `museum_assets?id=eq.${id}&ready=eq.false`, { method: 'DELETE' });
    }
    // A ready artwork can restart preparation after the cleanup snapshot was read.
    // Its staging objects are disposable; retain the newer allocation and lease.
    await settle(env, 'uploads', id, item.bytes, item.expires);
  }
  for (const [id, item] of Object.entries(snapshot.jobs)
    .filter(([, item]) => item.expires < cutoff)
    .slice(0, 1)) {
    if (!(await committed(env, id))) {
      // At most 2,000 media objects per schema-valid publication. Delete in bounded pages.
      for (let page = 0; page < 20; page++) {
        const list = await env.MUSEUM.list({ prefix: `published/${id}/`, limit: 100 });
        if (!list.objects.length) break;
        await env.MUSEUM.delete(list.objects.map((o) => o.key));
      }
      await env.MUSEUM.delete(`manifests/${id}.json`);
    }
    await env.MUSEUM.delete(`jobs/${id}.json`);
    await settle(env, 'jobs', id, item.bytes);
  }
}
export default {
  async scheduled(_controller: ScheduledController, env: Env, ctx: ExecutionContext) {
    ctx.waitUntil(cleanup(env));
  },
  async fetch(request: Request, env: Env) {
    try {
      return await handle(request, env);
    } catch (e) {
      if (e instanceof z.ZodError)
        return json({ error: 'Invalid museum data.', issues: e.issues.slice(0, 100) }, 422);
      if (e instanceof HttpError)
        return json(
          { error: e.message },
          e.status,
          e.status === 429 ? { 'Retry-After': '60' } : {},
        );
      console.error('Request failed', e instanceof Error ? e.message : 'Unknown error');
      return json(
        { error: 'The request failed. Reload to check the latest state before retrying.' },
        500,
      );
    }
  },
} satisfies ExportedHandler<Env>;
