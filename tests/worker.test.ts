import { beforeEach, afterEach, describe, it, expect, vi } from 'vitest';
import worker, { type Env } from '../worker/index';
import { sample } from '../src/core/sample';
import { publicDocument } from '../src/core/publication';
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
  async get(key: string, options: any = {}) {
    const item = this.items.get(key);
    if (!item) return null;
    if (options.onlyIf?.etagMatches && item.etag !== options.onlyIf.etagMatches)
      return { etag: item.etag };
    return this.object(key, item, options.range);
  }
  async head(key: string) {
    return this.get(key);
  }
  async delete(key: string) {
    this.items.delete(key);
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
      [...url.searchParams].every(
        ([k, v]) => !v.startsWith('eq.') || String(row[k]) === v.slice(3),
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
    } else rows = rows.filter(matches);
    return Response.json(rows);
  });
  vi.stubGlobal('fetch', fetchMock);
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
