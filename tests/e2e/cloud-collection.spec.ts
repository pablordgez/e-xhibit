import { test, expect } from '@playwright/test';
import { build } from 'esbuild';
import sharp from 'sharp';
import { sample } from '../../src/core/sample';

test('43 legacy artworks load together and title edits save without image preparation or repeated signing', async ({
  page,
}) => {
  test.slow();
  const document = structuredClone(sample),
    previous = document.assets;
  document.assets = Array.from({ length: 43 }, (_, index) => {
    const id = crypto.randomUUID();
    return {
      ...previous[index % previous.length],
      id,
      title: `Photograph ${index + 1}`,
      source: `originals/${id}`,
      variants: Object.fromEntries(
        ['512', '1024', '2048'].map((size) => [size, `variants/${id}/${size}`]),
      ),
    };
  });
  const replaced = new Map(previous.map((asset, index) => [asset.id, document.assets[index].id]));
  for (const region of document.regions)
    if (region.assetId) region.assetId = replaced.get(region.assetId);
  for (const room of document.rooms) room.shelves = room.shelves.map((id) => replaced.get(id)!);
  let snapshot = { document, revision: 7, publication: 'existing-publication' };
  const requests: string[] = [],
    batches: string[][] = [];
  const image = await sharp({
    create: { width: 32, height: 48, channels: 3, background: '#879b78' },
  })
    .webp()
    .toBuffer();
  await page.route('**/fixture-media/**', (route) =>
    route.fulfill({ body: image, contentType: 'image/webp' }),
  );
  await page.route('**/api/**', async (route) => {
    const request = route.request(),
      url = new URL(request.url()),
      path = url.pathname;
    requests.push(path);
    if (path === '/api/draft') {
      if (request.method() === 'PUT') {
        const input = request.postDataJSON();
        expect(input.revision).toBe(snapshot.revision);
        snapshot = { ...snapshot, document: input.document, revision: input.revision + 1 };
      }
      await route.fulfill({ json: snapshot });
    } else if (path === '/api/media-urls') {
      const keys = url.searchParams.get('keys')!.split(',');
      expect(keys.length).toBeLessThanOrEqual(50);
      batches.push(keys);
      await route.fulfill({
        json: { urls: keys.map((key) => ({ key, url: '/fixture-media/' + key })), expiresIn: 240 },
      });
    } else if (path === '/api/limits')
      await route.fulfill({ json: { bytes: 100_000_000, pixels: 100_000_000 } });
    else if (path === '/api/uploads/revalidate' || path === '/api/media-url')
      await route.fulfill({ status: 429, json: { error: 'Too many editing requests.' } });
    else throw Error('Unexpected API request: ' + path);
  });
  // Mount the real cloud studio; replace only Supabase session lookup and API/R2
  // transport. Server tests separately enforce legacy-save and publication policy.
  const bundle = await build({
    stdin: {
      contents: `import {createRoot} from 'react-dom/client'; import Editor from './src/components/Editor'; document.getElementById('root').style.display = 'none'; const host = document.createElement('div'); document.body.appendChild(host); createRoot(host).render(<Editor onVisit={() => {}} onSignOut={() => {}} />);`,
      resolveDir: process.cwd(),
      loader: 'tsx',
    },
    bundle: true,
    write: false,
    format: 'iife',
    platform: 'browser',
    jsx: 'automatic',
    define: {
      'import.meta.env.DEV': 'false',
      'import.meta.env.VITE_SUPABASE_URL': '"https://auth.test"',
      'import.meta.env.VITE_SUPABASE_ANON_KEY': '"public-fixture"',
    },
    plugins: [
      {
        name: 'session-fixture',
        setup(builder) {
          builder.onResolve({ filter: /^@supabase\/supabase-js$/ }, () => ({
            path: 'session',
            namespace: 'fixture',
          }));
          builder.onLoad({ filter: /.*/, namespace: 'fixture' }, () => ({
            contents: `export const createClient = () => ({auth: {getSession: async () => ({data: {session: {access_token: 'browser-fixture'}}})}});`,
          }));
        },
      },
    ],
  });
  await page.goto('/');
  await page.addScriptTag({ content: bundle.outputFiles[0].text });
  await page.getByRole('button', { name: /Art collection/ }).click();
  await expect(page.locator('.art-card img')).toHaveCount(43);
  for (const index of [14, 28, 42])
    await page.locator('.art-card').nth(index).scrollIntoViewIfNeeded();
  await expect
    .poll(async () =>
      page
        .locator('.art-card img')
        .evaluateAll((images) =>
          images.every(
            (image) =>
              (image as HTMLImageElement).complete && (image as HTMLImageElement).naturalWidth > 0,
          ),
        ),
    )
    .toBe(true);
  await page.locator('.art-card').first().click();
  const title = page.getByRole('dialog').getByLabel('Title', { exact: true });
  await title.fill('Puerta al mar updated');
  await expect.poll(() => snapshot.document.assets[0].title).toBe('Puerta al mar updated');
  await expect(
    page.getByRole('main').getByText('All changes saved', { exact: true }),
  ).toBeVisible();
  const signedBefore = batches.flat().length;
  await title.fill('Puerta al mar final');
  await expect.poll(() => snapshot.document.assets[0].title).toBe('Puerta al mar final');
  expect(batches.flat().length).toBe(signedBefore);
  expect(requests).not.toContain('/api/uploads/revalidate');
  expect(requests).not.toContain('/api/media-url');
  expect(snapshot.publication).toBe('existing-publication');
  await page.getByRole('button', { name: 'Close dialog' }).click();
  await expect(page.locator('.art-card img')).toHaveCount(43);
  expect(batches.length).toBeLessThanOrEqual(3);
  await page.reload();
  await page.addScriptTag({ content: bundle.outputFiles[0].text });
  await page.getByRole('button', { name: /Art collection/ }).click();
  await expect(page.locator('.art-card').first()).toContainText('Puerta al mar final');
  await expect(page.locator('.art-card img')).toHaveCount(43);
  for (const index of [14, 28, 42])
    await page.locator('.art-card').nth(index).scrollIntoViewIfNeeded();
  await expect
    .poll(() =>
      page
        .locator('.art-card img')
        .evaluateAll((images) =>
          images.every((image) => (image as HTMLImageElement).naturalWidth > 0),
        ),
    )
    .toBe(true);
});
