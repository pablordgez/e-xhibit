import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { sample } from '../src/core/sample';

vi.mock('@supabase/supabase-js', () => ({
  createClient: () => ({
    auth: { getSession: async () => ({ data: { session: { access_token: 'test-session' } } }) },
  }),
}));
beforeEach(() => {
  vi.resetModules();
  vi.stubEnv('VITE_SUPABASE_URL', 'https://auth.test');
  vi.stubEnv('VITE_SUPABASE_ANON_KEY', 'public-test-key');
});
afterEach(() => vi.unstubAllGlobals());
afterEach(() => vi.unstubAllEnvs());

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
