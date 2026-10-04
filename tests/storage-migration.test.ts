import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { sample } from '../src/core/sample';

const session = vi.hoisted(() => ({ token: 'test-session' }));
vi.mock('@supabase/supabase-js', () => ({
  createClient: () => ({
    auth: { getSession: async () => ({ data: { session: { access_token: session.token } } }) },
  }),
}));
beforeEach(() => {
  session.token = 'test-session';
  vi.resetModules();
  vi.stubEnv('VITE_SUPABASE_URL', 'https://auth.test');
  vi.stubEnv('VITE_SUPABASE_ANON_KEY', 'public-test-key');
});
afterEach(() => vi.unstubAllGlobals());
afterEach(() => vi.unstubAllEnvs());
afterEach(() => vi.useRealTimers());

function legacyDocument() {
  const document = structuredClone(sample),
    asset = document.assets[0];
  const oldId = asset.id;
  asset.id = crypto.randomUUID();
  asset.source = `originals/${asset.id}`;
  asset.variants = Object.fromEntries(
    ['512', '1024', '2048'].map((size) => [size, `variants/${asset.id}/${size}`]),
  );
  for (const region of document.regions) if (region.assetId === oldId) region.assetId = asset.id;
  for (const room of document.rooms)
    room.shelves = room.shelves.map((id) => (id === oldId ? asset.id : id));
  return document;
}

it('revalidates an unchanged saved legacy draft before publishing without editing its document or revision', async () => {
  const document = legacyDocument(),
    before = structuredClone(document),
    requests: string[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (path: string, init: RequestInit = {}) => {
      requests.push(path);
      if (path.startsWith('/api/asset-status?'))
        return Response.json([{ id: document.assets[0].id, validated: false }]);
      if (path === '/api/uploads/revalidate')
        return Response.json({ ready: true, asset: document.assets[0] });
      if (path === '/api/publish') {
        expect(JSON.parse(init.body as string)).toEqual({ revision: 7, previous: null });
        return Response.json({ id: 'published-version', cursor: 0, done: true });
      }
      throw Error('Unexpected request');
    }),
  );
  const { publish } = await import('../src/lib/storage');
  expect(await publish(document, 7, null)).toEqual({ id: 'published-version' });
  expect(requests).toEqual([
    `/api/asset-status?ids=${document.assets[0].id}`,
    '/api/uploads/revalidate',
    '/api/publish',
  ]);
  expect(document).toEqual(before);
});

it('does not start publication when legacy original validation fails', async () => {
  const document = legacyDocument(),
    requests: string[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (path: string) => {
      requests.push(path);
      if (path.startsWith('/api/asset-status?'))
        return Response.json([{ id: document.assets[0].id, validated: false }]);
      if (path === '/api/uploads/revalidate')
        return Response.json({ error: 'Original is missing.' }, { status: 422 });
      throw Error('Publication must not start');
    }),
  );
  const { publish } = await import('../src/lib/storage');
  await expect(publish(document, 7, null)).rejects.toThrow('Original is missing.');
  expect(requests).not.toContain('/api/publish');
});

it('imports in bounded image-check batches and saves using the current revision without publishing', async () => {
  const document = legacyDocument();
  const asset = document.assets[0];
  for (let i = 0; i < 20; i++) {
    const id = crypto.randomUUID();
    document.assets.push({
      ...asset,
      id,
      source: `originals/${id}`,
      variants: Object.fromEntries(
        ['512', '1024', '2048'].map((size) => [size, `variants/${id}/${size}`]),
      ),
    });
  }
  const checks: string[][] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (path: string, init: RequestInit = {}) => {
      if (path.startsWith('/api/asset-status?')) {
        const url = new URL(path, 'https://museum.test'),
          ids = url.searchParams.get('ids')!.split(',');
        if (url.searchParams.has('check-files')) checks.push(ids);
        return Response.json(ids.map((id) => ({ id, validated: true, filesAvailable: true })));
      }
      expect(path).toBe('/api/draft');
      expect(init.method).toBe('PUT');
      expect(JSON.parse(init.body as string)).toEqual({ document, revision: 7 });
      return Response.json({ document, revision: 8, publication: 'existing-publication' });
    }),
  );
  const { importDraft } = await import('../src/lib/storage');
  expect(await importDraft(document, 7)).toMatchObject({
    revision: 8,
    publication: 'existing-publication',
  });
  expect(checks.map((ids) => ids.length)).toEqual([10, 10, 1]);
});
it('does not write the draft when cloud image files are missing', async () => {
  const document = legacyDocument(),
    paths: string[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (path: string) => {
      paths.push(path);
      return Response.json([{ id: document.assets[0].id, validated: true, filesAvailable: false }]);
    }),
  );
  const { importDraft } = await import('../src/lib/storage');
  await expect(importDraft(document, 7)).rejects.toThrow('current draft has not been replaced');
  expect(paths).not.toContain('/api/draft');
});
it('propagates a concurrent-editor conflict rather than retrying against a newer draft', async () => {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => Response.json({ error: 'Another editor saved changes.' }, { status: 409 })),
  );
  const { importDraft } = await import('../src/lib/storage');
  await expect(importDraft(sample, 7)).rejects.toMatchObject({ status: 409 });
  expect(fetch).toHaveBeenCalledTimes(1);
});

it('saves a legacy title edit directly without depending on image preparation', async () => {
  const document = legacyDocument();
  document.assets[0].title = 'Puerta al mar updated';
  vi.stubGlobal(
    'fetch',
    vi.fn(async (path: string, init: RequestInit = {}) => {
      expect(path).toBe('/api/draft');
      expect(JSON.parse(init.body as string)).toEqual({ document, revision: 7 });
      return Response.json({ document, revision: 8, publication: null });
    }),
  );
  const { saveDraft } = await import('../src/lib/storage');
  expect((await saveDraft(document, 7)).document.assets[0].title).toBe('Puerta al mar updated');
  expect(fetch).toHaveBeenCalledTimes(1);
});

it('reuses image signatures within a session and obtains new ones after the session changes', async () => {
  const asset = legacyDocument().assets[0];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (path: string, init: RequestInit = {}) => {
      const key = new URL(path, 'https://museum.test').searchParams.get('keys')!;
      const token = new Headers(init.headers).get('Authorization');
      return Response.json({ urls: [{ key, url: token }], expiresIn: 240 });
    }),
  );
  const { assetUrl } = await import('../src/lib/storage');
  expect(await assetUrl(asset, '512')).toBe('Bearer test-session');
  expect(await assetUrl({ ...asset, title: 'New title' }, '512')).toBe('Bearer test-session');
  expect(fetch).toHaveBeenCalledTimes(1);
  session.token = 'another-session';
  expect(await assetUrl(asset, '512')).toBe('Bearer another-session');
  expect(fetch).toHaveBeenCalledTimes(2);
});

it('waits for a rate-limit cooldown once, retaining the revision, and never retries a conflict', async () => {
  vi.useFakeTimers();
  const replies = [
    Response.json({ error: 'Busy' }, { status: 429, headers: { 'Retry-After': '1' } }),
    Response.json({ document: sample, revision: 8, publication: null }),
  ];
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => replies.shift()!),
  );
  const { saveDraft } = await import('../src/lib/storage');
  const saving = saveDraft(sample, 7);
  await vi.advanceTimersByTimeAsync(999);
  expect(fetch).toHaveBeenCalledTimes(1);
  await vi.advanceTimersByTimeAsync(1);
  expect((await saving).revision).toBe(8);
  expect(fetch).toHaveBeenCalledTimes(2);
  for (const [, init] of vi.mocked(fetch).mock.calls)
    expect(JSON.parse(init!.body as string).revision).toBe(7);
  vi.mocked(fetch)
    .mockClear()
    .mockImplementation(async () => Response.json({ error: 'Conflict' }, { status: 409 }));
  await expect(saveDraft(sample, 7)).rejects.toMatchObject({ status: 409 });
  expect(fetch).toHaveBeenCalledTimes(1);
});
