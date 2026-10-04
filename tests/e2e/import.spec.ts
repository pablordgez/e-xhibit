import { test, expect, type Page } from '@playwright/test';
import sharp from 'sharp';
import { sample } from '../../src/core/sample';

async function choose(page: Page, value: unknown) {
  await page.getByLabel('Museum document file').setInputFiles({
    name: 'museum-backup.json',
    mimeType: 'application/json',
    buffer: Buffer.from(JSON.stringify(value)),
  });
}
async function exported(page: Page) {
  const waiting = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Export museum document', exact: true }).click();
  const download = await waiting;
  expect(download.suggestedFilename()).toBe('museum-backup.json');
  const stream = await download.createReadStream();
  const chunks: Buffer[] = [];
  for await (const chunk of stream!) chunks.push(Buffer.from(chunk));
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}
test('an actual exported draft imports with its uploaded images, supports cancel and undo, and leaves publication unchanged', async ({
  page,
}) => {
  await page.goto('/');
  await page.getByRole('button', { name: /Art collection/ }).click();
  await page.locator('input[type=file]').setInputFiles({
    name: 'Backup photograph.png',
    mimeType: 'image/png',
    buffer: await sharp({ create: { width: 32, height: 48, channels: 3, background: '#879b78' } })
      .png()
      .toBuffer(),
  });
  await expect(page.getByRole('button', { name: /Backup photograph/ })).toBeVisible();
  await page.getByRole('button', { name: 'Museum settings', exact: true }).click();
  await page.getByLabel('Museum name', { exact: true }).fill('Saved exhibition');
  await expect(page.getByText('All changes saved', { exact: true })).toBeVisible();
  const backup = await exported(page);
  await page.getByRole('button', { name: 'Save and publish', exact: true }).click();
  await page
    .getByRole('dialog')
    .getByRole('button', { name: 'Save and publish', exact: true })
    .click();
  await expect(page.getByRole('heading', { name: 'Your museum is open.' })).toBeVisible();
  await page.getByRole('button', { name: 'Close dialog' }).click();
  const publication = await page.evaluate(() => localStorage.getItem('exhibit-current'));
  await page.getByLabel('Museum name', { exact: true }).fill('Replacement draft');
  await choose(page, backup);
  const dialog = page.getByRole('dialog', { name: 'Import museum document' });
  await expect(dialog.getByText('Saved exhibition', { exact: true })).toBeVisible();
  await dialog.getByRole('button', { name: 'Cancel', exact: true }).click();
  await expect(page.getByLabel('Museum name', { exact: true })).toHaveValue('Replacement draft');
  await choose(page, backup);
  await dialog.getByRole('button', { name: 'Replace draft', exact: true }).click();
  await expect(page.getByRole('status')).toHaveText(
    'Museum document imported and saved. Review it before publishing.',
  );
  await expect(page.getByLabel('Museum name', { exact: true })).toHaveValue('Saved exhibition');
  expect(await page.evaluate(() => localStorage.getItem('exhibit-current'))).toBe(publication);
  await page.getByRole('button', { name: 'Museum builder', exact: true }).click();
  await page.getByRole('button', { name: 'Undo', exact: true }).click();
  await page.getByRole('button', { name: 'Museum settings', exact: true }).click();
  await expect(page.getByLabel('Museum name', { exact: true })).toHaveValue('Replacement draft');
  await choose(page, backup);
  await dialog.getByRole('button', { name: 'Replace draft', exact: true }).click();
  await expect(dialog).not.toBeVisible();
  await page.reload();
  await page.getByRole('button', { name: 'Museum settings', exact: true }).click();
  await expect(page.getByLabel('Museum name', { exact: true })).toHaveValue('Saved exhibition');
  await page.getByRole('button', { name: /Art collection/ }).click();
  await expect(
    page.getByRole('button', { name: /Backup photograph/ }).locator('img'),
  ).toBeVisible();
});
test('missing images, unsafe references, and malformed files leave the working draft intact', async ({
  page,
}) => {
  await page.goto('/');
  await page.getByRole('button', { name: 'Museum settings', exact: true }).click();
  const document = structuredClone(sample),
    asset = document.assets[0],
    old = asset.id;
  asset.id = crypto.randomUUID();
  asset.source = `originals/${asset.id}`;
  asset.variants = Object.fromEntries(
    ['512', '1024', '2048'].map((size) => [size, `variants/${asset.id}/${size}`]),
  );
  for (const region of document.regions) if (region.assetId === old) region.assetId = asset.id;
  for (const room of document.rooms)
    room.shelves = room.shelves.map((id) => (id === old ? asset.id : id));
  document.name = 'Must not replace';
  await choose(page, document);
  const dialog = page.getByRole('dialog', { name: 'Import museum document' });
  await dialog.getByRole('button', { name: 'Replace draft', exact: true }).click();
  await expect(dialog.getByRole('alert')).toContainText('missing from this browser');
  await dialog.getByRole('button', { name: 'Cancel', exact: true }).click();
  const unsafe = structuredClone(sample);
  unsafe.assets[0].source = 'https://attacker.test/image';
  await choose(page, unsafe);
  await expect(page.getByRole('alert')).toContainText('supported museum image files');
  await page.getByLabel('Museum document file').setInputFiles({
    name: 'broken.json',
    mimeType: 'application/json',
    buffer: Buffer.from('{broken'),
  });
  await expect(page.getByRole('alert')).toContainText('not valid JSON');
  await expect(page.getByLabel('Museum name', { exact: true })).toHaveValue('Still / Life');
  await page.reload();
  await page.getByRole('button', { name: 'Museum settings', exact: true }).click();
  await expect(page.getByLabel('Museum name', { exact: true })).toHaveValue('Still / Life');
});
