import { beforeEach, afterEach, describe, it, expect, vi } from 'vitest';
import worker, { cleanup, type Env } from '../worker/index';
import { sample } from '../src/core/sample';
import { publicDocument } from '../src/core/publication';
import { reserve, completeUpload } from '../worker/resources';
type Stored = { bytes: Uint8Array; etag: string; metadata: any; uploaded: Date };
class Bucket {
  items = new Map<string, Stored>();
  failPrefix = '';
  async put(key: string, value: any, options: any = {}) {
    if (this.failPrefix && key.startsWith(this.failPrefix))
      throw Error('Simulated storage interruption');
    const old = this.items.get(key);
    if (options.onlyIf?.etagDoesNotMatch === '*' && old) return null;
    if (options.onlyIf?.etagMatches && old?.etag !== options.onlyIf.etagMatches) return null;
    let bytes: Uint8Array;
    if (typeof value === 'string') bytes = new TextEncoder().encode(value);
    else if (value instanceof Uint8Array) bytes = value;
    else bytes = new Uint8Array(await new Response(value).arrayBuffer());
    const item = {
      bytes,
      etag: crypto.randomUUID(),
      metadata: options.httpMetadata ?? {},
      uploaded: new Date(),
    };
    this.items.set(key, item);
    return this.object(key, item);
  }
  object(key: string, item: Stored, range?: any) {
    let bytes = item.bytes;
    if (range) bytes = bytes.slice(range.offset, range.offset + range.length);
    return {
      key,
      size: item.bytes.length,
      etag: item.etag,
      httpEtag: '"' + item.etag + '"',
      httpMetadata: item.metadata,
      uploaded: item.uploaded,
      body: new Blob([bytes as BlobPart]).stream(),
      json: async () => JSON.parse(new TextDecoder().decode(bytes)),
      arrayBuffer: async () =>
        bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
      writeHttpMetadata: (headers: Headers) =>
        headers.set('Content-Type', item.metadata.contentType ?? 'application/octet-stream'),
    };
  }
  async get(key: string, options: any = {}): Promise<any> {
    const item = this.items.get(key);
    if (!item) return null;
    if (options.onlyIf?.etagMatches && item.etag !== options.onlyIf.etagMatches)
      return { etag: item.etag };
    return this.object(key, item, options.range);
  }
  async head(key: string) {
    return this.get(key);
  }
  async createMultipartUpload(key: string, options: any = {}) {
    const parts = new Map<number, Uint8Array>();
    return {
      uploadId: crypto.randomUUID(),
      uploadPart: async (number: number, bytes: Uint8Array) => {
        parts.set(number, bytes.slice());
        return { partNumber: number, etag: String(number) };
      },
      complete: async () => {
        const bytes = new Uint8Array(
          [...parts.values()].reduce((sum, part) => sum + part.length, 0),
        );
        let offset = 0;
        for (const part of parts.values()) {
          bytes.set(part, offset);
          offset += part.length;
        }
        return this.put(key, bytes, options);
      },
      abort: async () => {
        parts.clear();
      },
    };
  }
  resumeMultipartUpload() {
    return { abort: async () => {} };
  }
  async delete(key: string | string[]) {
    for (const item of Array.isArray(key) ? key : [key]) this.items.delete(item);
  }
  async list(options: any = {}) {
    return {
      objects: [...this.items]
        .filter(([key]) => !options.prefix || key.startsWith(options.prefix))
        .map(([key, item]) => this.object(key, item)),
      truncated: false,
    };
  }
}
let bucket: Bucket, env: Env, tables: Record<string, any[]>, fetchMock: ReturnType<typeof vi.fn>;
const owner = '00000000-0000-4000-8000-000000000001';
function req(path: string, method = 'GET', body?: unknown, auth = true) {
  return new Request('https://museum.test/api' + path, {
    method,
    headers: {
      ...(auth ? { Authorization: 'Bearer good' } : {}),
      'Content-Type': 'application/json',
      Origin: 'https://museum.test',
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}
const call = (path: string, method = 'GET', body?: unknown, auth = true) =>
  worker.fetch(req(path, method, body, auth), env);
beforeEach(() => {
  bucket = new Bucket();
  env = {
    MUSEUM: bucket as any,
    ASSETS: { fetch: async () => new Response('sample') } as any,
    SUPABASE_URL: 'https://supabase.test',
    SUPABASE_SERVICE_ROLE_KEY: 'server-only',
    APP_ORIGIN: 'https://museum.test',
    R2_ACCOUNT_ID: 'account',
    R2_BUCKET_NAME: 'museum',
    R2_ACCESS_KEY_ID: 'key',
    R2_SECRET_ACCESS_KEY: 'secret',
    AUTH_LIMITER: { limit: async () => ({ success: true }) },
    CREATE_LIMITER: { limit: async () => ({ success: true }) },
    IMAGES: {} as ImagesBinding,
  };
  tables = {
    museum_members: [{ user_id: owner, email: 'owner@test.com', role: 'owner' }],
    museum_drafts: [{ id: true, revision: 0, document: structuredClone(sample) }],
    museum_assets: [],
  };
  fetchMock = vi.fn(async (input: string, init: RequestInit = {}) => {
    const url = new URL(input);
    if (url.pathname === '/auth/v1/user')
      return Response.json({ id: owner, email: 'owner@test.com' });
    const table = url.pathname.split('/').at(-1)!;
    let rows = tables[table] ?? [];
    const matches = (row: any) =>
      [...url.searchParams].every(([k, v]) =>
        v.startsWith('in.(')
          ? v.slice(4, -1).split(',').includes(String(row[k]))
          : !v.startsWith('eq.') || String(row[k]) === v.slice(3),
      );
    if (init.method === 'PATCH') {
      rows = rows.filter(matches);
      for (const r of rows) Object.assign(r, JSON.parse(init.body as string));
    } else if (init.method === 'POST') {
      const value = JSON.parse(init.body as string);
      tables[table].push(value);
      rows = [value];
    } else if (init.method === 'DELETE') {
      rows = rows.filter(matches);
      tables[table] = tables[table].filter((r) => !rows.includes(r));
    } else {
      rows = rows.filter(matches).slice();
      if (url.searchParams.has('order')) rows.sort((a, b) => a.id.localeCompare(b.id));
      const offset = Number(url.searchParams.get('offset') ?? 0),
        limit = Number(url.searchParams.get('limit') ?? 1000);
      rows = rows.slice(offset, offset + limit);
    }
    return Response.json(rows);
  });
  vi.stubGlobal('fetch', fetchMock);
});

function uploadFixture() {
  const id = crypto.randomUUID(),
    bytes = new Uint8Array(24);
  bytes.set([137, 80, 78, 71, 13, 10, 26, 10]);
  const view = new DataView(bytes.buffer);
  view.setUint32(16, 32);
  view.setUint32(20, 32);
  const asset = {
    ...structuredClone(sample.assets[0]),
    id,
    width: 32,
    height: 32,
    bytes: 24,
    mime: 'image/png',
    ready: false,
    source: `originals/${id}`,
    variants: Object.fromEntries(['512', '1024', '2048'].map((s) => [s, `variants/${id}/${s}`])),
  };
  return { asset, bytes, files: [{ key: asset.source, bytes: 24, mime: 'image/png' }] };
}
async function uploadBytes(
  asset: ReturnType<typeof uploadFixture>['asset'],
  bytes: Uint8Array,
  headers: Record<string, string> = {},
) {
  return worker.fetch(
    new Request(`https://museum.test/api/uploads/${asset.id}/file`, {
      method: 'PUT',
      headers: {
        Authorization: 'Bearer good',
        Origin: 'https://museum.test',
        'Content-Type': asset.mime,
        ...headers,
      },
      body: bytes as BodyInit,
    }),
    env,
  );
}
describe('Supabase API key compatibility', () => {
  it.each(['server-only', 'sb_secret_test_fixture'])(
    'authenticates backend requests with %s',
    async (key) => {
      env.SUPABASE_SERVICE_ROLE_KEY = key;
      expect((await call('/draft')).status).toBe(200);
      const calls = fetchMock.mock.calls as [string, RequestInit][];
      const identityHeaders = new Headers(
        calls.find(([url]) => url.endsWith('/auth/v1/user'))![1].headers,
      );
      expect(identityHeaders.get('apikey')).toBe(key);
      expect(identityHeaders.get('Authorization')).toBe('Bearer good');
      for (const [url, init] of calls.filter(([url]) => url.includes('/rest/v1/'))) {
        const headers = new Headers(init.headers);
        expect(headers.get('apikey'), url).toBe(key);
        expect(headers.get('Authorization'), url).toBe(
          key.startsWith('sb_secret_') ? null : `Bearer ${key}`,
        );
      }
    },
  );
  it('uses the new secret key for owner invitations without treating it as a JWT', async () => {
    env.SUPABASE_SERVICE_ROLE_KEY = 'sb_secret_test_fixture';
    const original = fetchMock.getMockImplementation() as (
      input: string,
      init: RequestInit,
    ) => Promise<Response>;
    fetchMock.mockImplementation(async (input: string, init: RequestInit = {}) => {
      if (new URL(input).pathname === '/auth/v1/invite')
        return Response.json({ id: crypto.randomUUID() });
      return original(input, init);
    });
    expect((await call('/members', 'POST', { email: 'editor@example.com' })).status).toBe(200);
    const invite = fetchMock.mock.calls.find(([url]) => String(url).includes('/auth/v1/invite'))!;
    const headers = new Headers(invite[1]?.headers);
    expect(headers.get('apikey')).toBe(env.SUPABASE_SERVICE_ROLE_KEY);
    expect(headers.has('Authorization')).toBe(false);
  });
});

describe('security regressions: uploads and budgets', () => {
  it('accepts large originals with a bounded canonical master, and rejects missing or invalid master declarations', async () => {
    const { asset } = uploadFixture();
    asset.bytes = 30_000_000;
    const original = { key: asset.source, bytes: asset.bytes, mime: asset.mime };
    const master = { key: `masters/${asset.id}`, bytes: 1000, mime: 'image/webp' };
    expect((await call('/uploads', 'POST', { asset, files: [original] })).status).toBe(503);
    for (const invalid of [
      { ...master, key: 'originals/another-image' },
      { ...master, bytes: 9_000_001 },
      { ...master, mime: 'image/png' },
    ])
      expect((await call('/uploads', 'POST', { asset, files: [original, invalid] })).status).toBe(
        422,
      );
    const response = await call('/uploads', 'POST', { asset, files: [original, master] });
    expect(response.status).toBe(200);
    expect(((await response.json()) as any).uploads).toEqual([
      { key: original.key, url: `/api/uploads/${asset.id}/file` },
      { key: master.key, url: `/api/uploads/${asset.id}/master` },
    ]);
    const ledger = await (await bucket.get('control/resources.json'))!.json();
    expect(ledger.bytes).toBe(asset.bytes * 2 + 27_004_096 + master.bytes);
  });
  it('protects master uploads with authentication, membership ownership, exact lengths and immutable claims', async () => {
    const { asset, files, bytes } = uploadFixture();
    const master = { key: `masters/${asset.id}`, bytes: 30, mime: 'image/webp' };
    await call('/uploads', 'POST', { asset, files: [...files, master] });
    const transfer = (data: Uint8Array, authenticated = true) =>
      worker.fetch(
        new Request(`https://museum.test/api/uploads/${asset.id}/master`, {
          method: 'PUT',
          headers: {
            ...(authenticated ? { Authorization: 'Bearer good' } : {}),
            Origin: 'https://museum.test',
            'Content-Type': 'image/webp',
            'Content-Disposition': 'inline',
          },
          body: data as BodyInit,
        }),
        env,
      );
    expect((await transfer(new Uint8Array(30), false)).status).toBe(401);
    const state = await (await bucket.get('control/resources.json'))!.json();
    state.uploads[asset.id].user = 'another-editor';
    await bucket.put('control/resources.json', JSON.stringify(state));
    expect((await transfer(new Uint8Array(30))).status).toBe(403);
    state.uploads[asset.id].user = owner;
    await bucket.put('control/resources.json', JSON.stringify(state));
    expect((await transfer(new Uint8Array(30))).status).toBe(200);
    expect((await transfer(new Uint8Array(30))).status).toBe(409);
    expect((await uploadBytes(asset, bytes)).status).toBe(200);
    expect(bucket.items.has(`staging/masters/${asset.id}`)).toBe(true);
    expect(bucket.items.has(`control/uploads/${asset.id}.master.json`)).toBe(true);
    // Scheduled expiration accounts for both transfers and cannot leave a master outside the budget.
    state.uploads[asset.id].expires = Date.now() - 26 * 60 * 60 * 1000;
    await bucket.put('control/resources.json', JSON.stringify(state));
    await cleanup(env);
    expect(bucket.items.has(`staging/masters/${asset.id}`)).toBe(false);
    expect(bucket.items.has(`control/uploads/${asset.id}.master.json`)).toBe(false);
    expect(bucket.items.has(`staging/originals/${asset.id}`)).toBe(false);
  });
  it('aborts oversized or truncated master streams without committing a staging object', async () => {
    for (const length of [29, 31]) {
      const { asset, files } = uploadFixture();
      await call('/uploads', 'POST', {
        asset,
        files: [...files, { key: `masters/${asset.id}`, bytes: 30, mime: 'image/webp' }],
      });
      const response = await worker.fetch(
        new Request(`https://museum.test/api/uploads/${asset.id}/master`, {
          method: 'PUT',
          headers: {
            Authorization: 'Bearer good',
            Origin: 'https://museum.test',
            'Content-Type': 'image/webp',
          },
          body: new Uint8Array(length),
        }),
        env,
      );
      expect(response.status).toBe(length > 30 ? 413 : 422);
      expect(bucket.items.has(`staging/masters/${asset.id}`)).toBe(false);
    }
  });
  it('returns only an authenticated same-origin original upload endpoint', async () => {
    const { asset, files } = uploadFixture();
    const response = await call('/uploads', 'POST', { asset, files });
    expect(response.status).toBe(200);
    expect(((await response.json()) as any).uploads).toEqual([
      { key: asset.source, url: `/api/uploads/${asset.id}/file` },
    ]);
    expect(
      (
        await worker.fetch(
          new Request(`https://museum.test/api/uploads/${asset.id}/file`, {
            method: 'PUT',
            body: 'fake',
          }),
          env,
        )
      ).status,
    ).toBe(401);
  });
  it('rejects excess bytes before any durable upload and refuses encoding/type overrides', async () => {
    const { asset, files, bytes } = uploadFixture();
    await call('/uploads', 'POST', { asset, files });
    expect((await uploadBytes(asset, new Uint8Array(25))).status).toBe(413);
    expect((await uploadBytes(asset, bytes, { 'Content-Encoding': 'gzip' })).status).toBe(422);
    expect((await uploadBytes(asset, bytes, { 'Content-Type': 'text/html' })).status).toBe(422);
    expect(bucket.items.has('staging/' + asset.source)).toBe(false);
  });
  it('makes a staged original immutable against replay and strips client storage metadata', async () => {
    const { asset, files, bytes } = uploadFixture();
    await call('/uploads', 'POST', { asset, files });
    expect(
      (
        await uploadBytes(asset, bytes, {
          'Cache-Control': 'public',
          'Content-Disposition': 'inline',
        })
      ).status,
    ).toBe(200);
    expect((await uploadBytes(asset, bytes)).status).toBe(409);
    expect(bucket.items.get('staging/' + asset.source)?.metadata).toEqual({
      contentType: 'image/png',
      cacheControl: 'no-store',
      contentDisposition: 'attachment',
    });
  });
  it('rejects a header-only forged PNG when the trusted decoder cannot decode it', async () => {
    const { asset, files, bytes } = uploadFixture();
    await call('/uploads', 'POST', { asset, files });
    await uploadBytes(asset, bytes);
    env.IMAGES = {
      info: async () => ({ format: 'image/png', width: 32, height: 32, fileSize: 24 }),
      input: () => ({
        transform: () => ({
          output: async () => {
            throw Error('Decode failed');
          },
        }),
      }),
    } as any;
    expect((await call('/uploads/complete', 'POST', { id: asset.id })).status).toBe(422);
    expect(tables.museum_assets[0].ready).toBe(false);
    expect(bucket.items.has(asset.source)).toBe(false);
  });
  it('accepts only server-generated display variants and safe metadata after a successful decode', async () => {
    const { asset, files, bytes } = uploadFixture();
    await call('/uploads', 'POST', { asset, files });
    await uploadBytes(asset, bytes);
    const pixels = new Uint8Array(30);
    pixels.set(new TextEncoder().encode('RIFF'), 0);
    pixels.set(new TextEncoder().encode('WEBPVP8X'), 8);
    pixels[24] = 31;
    pixels[27] = 31;
    const output = vi.fn(async () => ({
      response: () =>
        new Response(pixels, {
          headers: { 'Content-Type': 'image/webp', 'Content-Encoding': 'gzip' },
        }),
    }));
    env.IMAGES = {
      info: async () => ({ format: 'image/png', width: 32, height: 32, fileSize: 24 }),
      input: () => ({ transform: () => ({ output }) }),
    } as any;
    expect((await call('/uploads/complete', 'POST', { id: asset.id })).status).toBe(200);
    expect(output).toHaveBeenCalledTimes(3);
    expect(output).toHaveBeenCalledWith({ format: 'image/webp', quality: 90, anim: false });
    for (const key of Object.values(asset.variants))
      expect(bucket.items.get(key)?.metadata).toEqual({
        contentType: 'image/webp',
        cacheControl: 'no-store',
      });
    expect(tables.museum_assets[0].files.every((f: any) => f.validation === 'images-v1')).toBe(
      true,
    );
    expect(new Uint8Array(await (await bucket.get(asset.source))!.arrayBuffer())).toEqual(bytes);
  });
  it('bounds outstanding work per member even when initialization requests race', async () => {
    const replies = await Promise.all(
      Array.from({ length: 8 }, () => {
        const { asset, files } = uploadFixture();
        return call('/uploads', 'POST', { asset, files });
      }),
    );
    expect(replies.filter((r) => r.status === 200)).toHaveLength(4);
    expect(replies.every((r) => [200, 409, 429].includes(r.status))).toBe(true);
    const state = await (await bucket.get('control/resources.json'))!.json();
    expect(Object.keys(state.uploads)).toHaveLength(4);
    expect(state.bytes).toBe(4 * (48 + 27_004_096));
  });
  it('rejects allocations above the configured lifetime storage budget', async () => {
    env.MAX_STORAGE_BYTES = '27004143';
    const { asset, files } = uploadFixture();
    expect((await call('/uploads', 'POST', { asset, files })).status).toBe(413);
    expect(tables.museum_assets).toHaveLength(0);
  });
  it('allows a normal collection upload batch beyond four completed assets while retaining its byte budget', async () => {
    for (let i = 0; i < 8; i++) {
      const id = crypto.randomUUID();
      await reserve(env, 'uploads', id, owner, 1000);
      await completeUpload(env, id, 500);
    }
    const state = await (await bucket.get('control/resources.json'))!.json();
    expect(state.assets).toBe(8);
    expect(state.bytes).toBe(4000);
    expect(Object.values(state.uploads).every((item: any) => item.complete)).toBe(true);
  });
  it('expires work and cleans pending bytes without resetting the conservative cost budget', async () => {
    const { asset, files, bytes } = uploadFixture();
    await call('/uploads', 'POST', { asset, files });
    await uploadBytes(asset, bytes);
    const state = await (await bucket.get('control/resources.json'))!.json();
    state.uploads[asset.id].expires = Date.now() - 26 * 60 * 60 * 1000;
    await bucket.put('control/resources.json', JSON.stringify(state));
    expect((await call('/uploads/complete', 'POST', { id: asset.id })).status).toBe(410);
    await cleanup(env);
    expect(bucket.items.has('staging/' + asset.source)).toBe(false);
    expect(tables.museum_assets).toHaveLength(0);
    const after = await (await bucket.get('control/resources.json'))!.json();
    expect(after.uploads).toEqual({});
    expect(after.bytes).toBe(state.bytes);
  });
  it('filters asset validation by referenced IDs even past the default database row cap', async () => {
    const { asset } = uploadFixture();
    const ready = { ...asset, ready: true };
    tables.museum_assets = Array.from({ length: 1100 }, () => ({
      id: crypto.randomUUID(),
      ready: true,
      asset: ready,
    }));
    tables.museum_assets.push({
      id: asset.id,
      ready: true,
      asset: ready,
      files: Array.from({ length: 4 }, () => ({ validation: 'images-v1' })),
    });
    const document = structuredClone(sample);
    document.assets.push(ready as any);
    expect((await call('/draft', 'PUT', { document, revision: 0 })).status).toBe(200);
    const urls = fetchMock.mock.calls
      .map(([url]) => String(url))
      .filter((url) => url.includes('/museum_assets?'));
    expect(urls.every((url) => url.includes('id=in.('))).toBe(true);
  });
  it('refuses to publish an old browser-validated upload before server revalidation', async () => {
    const { asset } = uploadFixture();
    const ready = { ...asset, ready: true };
    tables.museum_assets.push({
      id: asset.id,
      ready: true,
      asset: ready,
      files: [{ key: asset.source }],
    });
    const document = structuredClone(sample);
    document.assets.push(ready as any);
    expect((await call('/draft', 'PUT', { document, revision: 0 })).status).toBe(422);
  });
});
describe('security regressions: publication and request composition', () => {
  it('checks the commit registry even when media policy is cached, including the former asset hostname', async () => {
    const id = crypto.randomUUID(),
      key = `published/${id}/variants/art-1/512`,
      document = structuredClone(sample);
    document.assets[0].variants['512'] = key;
    await bucket.put('current.json', JSON.stringify({ id, committed: [id] }));
    await bucket.put(
      `manifests/${id}.json`,
      JSON.stringify({ id, name: document.name, createdAt: '', document }),
    );
    await bucket.put(key, new Uint8Array([1, 2, 3]), {
      httpMetadata: { contentType: 'image/webp' },
    });
    const media = '/media/' + encodeURIComponent(key);
    expect((await call(media, 'GET', undefined, false)).status).toBe(200);
    env.LEGACY_ASSET_ORIGIN = 'https://assets.museum.test';
    const legacy = () => worker.fetch(new Request(`https://assets.museum.test/${key}`), env);
    const before = await legacy();
    expect(before.status).toBe(200);
    expect(before.headers.get('Access-Control-Allow-Origin')).toBe(env.APP_ORIGIN);
    await bucket.put(
      'current.json',
      JSON.stringify({ id: 'different-version', committed: ['different-version'] }),
    );
    expect((await call(media, 'GET', undefined, false)).status).toBe(404);
    expect((await legacy()).status).toBe(404);
  });
  it('a losing job stays inaccessible through manifests, images, downloads and rollback', async () => {
    const old = await publish();
    tables.museum_drafts[0].document.assets[0].downloadable = true;
    const job = (await (
      await call('/publish', 'POST', { revision: 0, previous: old })
    ).json()) as any;
    await publish(old);
    let response = await call(`/publish/${job.id}/step`, 'POST', { cursor: 0 });
    if (response.status === 200)
      response = await call(`/publish/${job.id}/step`, 'POST', {
        cursor: ((await response.json()) as any).cursor,
      });
    expect(response.status).toBe(409);
    expect(bucket.items.has(`manifests/${job.id}.json`)).toBe(true);
    expect((await call(`/versions/${job.id}`, 'GET', undefined, false)).status).toBe(404);
    expect((await call(`/download/${job.id}/art-1`, 'GET', undefined, false)).status).toBe(404);
    expect(
      (
        await call(
          '/media/' + encodeURIComponent(`published/${job.id}/variants/art-1/512`),
          'GET',
          undefined,
          false,
        )
      ).status,
    ).toBe(404);
    expect((await call('/rollback', 'POST', { id: job.id, previous: old })).status).toBe(404);
    expect(((await (await call('/versions')).json()) as any[]).some((v) => v.id === job.id)).toBe(
      false,
    );
  });
  it('does not authenticate unknown endpoints or unsupported methods', async () => {
    expect((await call('/does-not-exist')).status).toBe(404);
    expect((await call('/draft', 'DELETE')).status).toBe(404);
    expect(fetchMock).not.toHaveBeenCalled();
  });
  it('applies a rate gate before contacting Supabase', async () => {
    env.AUTH_LIMITER.limit = async () => ({ success: false });
    expect((await call('/draft')).status).toBe(429);
    expect(fetchMock).not.toHaveBeenCalled();
  });
  it('applies member request limits before mutation', async () => {
    env.CREATE_LIMITER.limit = async () => ({ success: false });
    expect((await call('/publish', 'POST', { revision: 0, previous: null })).status).toBe(429);
    expect(bucket.items.size).toBe(0);
  });
  it('returns a controlled client error for malformed encoded media paths', async () => {
    expect((await call('/media/%E0%A4%A', 'GET', undefined, false)).status).toBe(400);
  });
  it('paginates history and inventory with bounded work per request', async () => {
    const ids = Array.from({ length: 45 }, () => crypto.randomUUID());
    await bucket.put('current.json', JSON.stringify({ id: ids.at(-1), committed: ids }));
    expect(await (await call('/versions')).json()).toHaveLength(20);
    expect(await (await call('/versions?offset=20')).json()).toHaveLength(20);
    expect(await (await call('/versions?offset=40')).json()).toHaveLength(5);
    const list = vi
      .spyOn(bucket, 'list')
      .mockResolvedValue({ objects: [], truncated: true, cursor: 'next-page' } as any);
    expect(await (await call('/usage')).json()).toMatchObject({
      next: { bucket: 0, cursor: 'next-page' },
    });
    expect(list).toHaveBeenCalledTimes(1);
  });
  it('does not automatically expose legacy manifests that might represent a failed job', async () => {
    const id = await publish();
    const other = crypto.randomUUID();
    await bucket.put(
      `manifests/${other}.json`,
      JSON.stringify({ id: other, name: sample.name, createdAt: '', document: sample }),
    );
    await bucket.put('current.json', JSON.stringify({ id }));
    expect((await call('/versions/' + other, 'GET', undefined, false)).status).toBe(404);
    expect((await call('/versions/import', 'POST', { ids: [other], previous: id })).status).toBe(
      200,
    );
    expect((await call('/versions/' + other, 'GET', undefined, false)).status).toBe(200);
  });
});
afterEach(() => vi.unstubAllGlobals());
async function publish(previous: string | null = null) {
  let response = await call('/publish', 'POST', {
    revision: tables.museum_drafts[0].revision,
    previous,
  });
  expect(response.status).toBe(200);
  let progress = (await response.json()) as any;
  while (!progress.done) {
    response = await call(`/publish/${progress.id}/step`, 'POST', { cursor: progress.cursor });
    expect(response.status).toBe(200);
    progress = await response.json();
  }
  return progress.id as string;
}
describe('private authoring boundary', () => {
  it('rejects anonymous reads and writes', async () => {
    expect((await call('/draft', 'GET', undefined, false)).status).toBe(401);
    expect((await call('/draft', 'PUT', {}, false)).status).toBe(401);
  });
  it('rejects revoked editors even with an otherwise valid session', async () => {
    tables.museum_members = [];
    expect((await call('/draft')).status).toBe(403);
  });
  it('rejects requests from another origin', async () => {
    const r = new Request('https://museum.test/api/draft', {
      method: 'PUT',
      headers: { Authorization: 'Bearer good', Origin: 'https://attacker.test' },
      body: '{}',
    });
    expect((await worker.fetch(r, env)).status).toBe(403);
  });
  it('saves with a revision precondition and rejects a stale writer', async () => {
    const document = structuredClone(sample);
    document.name = 'New name';
    document.categories = [{ id: 'landscapes', name: 'Landscapes' }];
    document.assets[0].categoryIds = ['landscapes'];
    document.regions[0].plaqueAuto = false;
    expect((await call('/draft', 'PUT', { document, revision: 0 })).status).toBe(200);
    expect((await call('/draft', 'PUT', { document: sample, revision: 0 })).status).toBe(409);
    expect(tables.museum_drafts[0].document.name).toBe('New name');
    expect(tables.museum_drafts[0].document.categories).toEqual(document.categories);
    expect(tables.museum_drafts[0].document.assets[0].categoryIds).toEqual(['landscapes']);
    expect(tables.museum_drafts[0].document.regions[0].plaqueAuto).toBe(false);
  });
  it('does not accept arbitrary media URLs as uploaded assets', async () => {
    const document = structuredClone(sample);
    document.assets[0].source = 'https://attacker.test/payload';
    expect((await call('/draft', 'PUT', { document, revision: 0 })).status).toBe(422);
  });
  it('reserves member management for the owner', async () => {
    tables.museum_members[0].role = 'editor';
    expect((await call('/members')).status).toBe(403);
  });
  it('does not expose private variants or originals through public media routes', async () => {
    await bucket.put('originals/private', 'secret');
    expect(
      (await call('/media/' + encodeURIComponent('originals/private'), 'GET', undefined, false))
        .status,
    ).toBe(404);
  });
});
describe('immutable publishing', () => {
  it('publishes using bounded steps and serves public content without Supabase', async () => {
    const id = await publish();
    fetchMock.mockRejectedValue(Error('Supabase paused'));
    const response = await call('/current', 'GET', undefined, false);
    expect(response.status).toBe(200);
    expect(((await response.json()) as any).id).toBe(id);
  });
  it('keeps old versions available when a newer museum is published', async () => {
    const old = await publish();
    tables.museum_drafts[0].document.name = 'New exhibition';
    const newer = await publish(old);
    const oldResponse = await call('/versions/' + old, 'GET', undefined, false);
    expect(((await oldResponse.json()) as any).document.name).toBe(sample.name);
    expect(((await (await call('/current', 'GET', undefined, false)).json()) as any).id).toBe(
      newer,
    );
  });
  it('leaves the old publication intact when storage fails', async () => {
    const old = await publish();
    const started = (await (
      await call('/publish', 'POST', { revision: 0, previous: old })
    ).json()) as any;
    bucket.failPrefix = 'manifests/';
    let result = await call(`/publish/${started.id}/step`, 'POST', { cursor: 0 });
    if (result.status === 200) {
      const progress = (await result.json()) as any;
      result = await call(`/publish/${started.id}/step`, 'POST', { cursor: progress.cursor });
    }
    expect(result.status).toBe(500);
    expect(((await (await call('/current', 'GET', undefined, false)).json()) as any).id).toBe(old);
  });
  it('rejects a concurrent stale publication at the pointer switch', async () => {
    const started = (await (
      await call('/publish', 'POST', { revision: 0, previous: null })
    ).json()) as any;
    const winner = await publish();
    let result = await call(`/publish/${started.id}/step`, 'POST', { cursor: 0 });
    if (result.status === 200) {
      const progress = (await result.json()) as any;
      result = await call(`/publish/${started.id}/step`, 'POST', { cursor: progress.cursor });
    }
    expect(result.status).toBe(409);
    expect(((await (await call('/current', 'GET', undefined, false)).json()) as any).id).toBe(
      winner,
    );
  });
  it('rolls back through a conditional pointer update', async () => {
    const old = await publish(),
      newer = await publish(old);
    expect((await call('/rollback', 'POST', { id: old, previous: newer })).status).toBe(200);
    expect(((await (await call('/current', 'GET', undefined, false)).json()) as any).id).toBe(old);
  });
  it('excludes unused private collection records', () => {
    const doc = structuredClone(sample);
    doc.assets.push({ ...doc.assets[0], id: 'private', title: 'Unreleased study' });
    doc.categories = [{ id: 'private-series', name: 'Unreleased series' }];
    doc.assets.at(-1)!.categoryIds = ['private-series'];
    expect(publicDocument(doc).assets.some((a) => a.id === 'private')).toBe(false);
    expect(publicDocument(doc).categories).toEqual([]);
  });
  it('checks both per-art permission and gift shop existence', async () => {
    tables.museum_drafts[0].document.assets[0].downloadable = true;
    const withShop = await publish();
    expect((await call(`/download/${withShop}/art-1`, 'GET', undefined, false)).status).toBe(200);
    expect((await call(`/download/${withShop}/art-2`, 'GET', undefined, false)).status).toBe(403);
    tables.museum_drafts[0].document.rooms.find((r: any) => r.kind === 'shop').kind = 'gallery';
    const noShop = await publish(withShop);
    expect((await call(`/download/${noShop}/art-1`, 'GET', undefined, false)).status).toBe(403);
    expect((await call(`/download/${withShop}/art-1`, 'GET', undefined, false)).status).toBe(200);
  });
});
