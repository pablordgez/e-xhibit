import { test, expect } from '@playwright/test';
test('edit the floor plan, preserve undo history, and publish a stable version', async ({
  page,
  context,
}) => {
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'Museum builder' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Ready to publish' })).toBeVisible();
  await page.screenshot({ path: 'output/playwright/studio.png', fullPage: true });
  await page.getByLabel('Room name', { exact: true }).fill('Light and shadow');
  await page.getByRole('button', { name: 'Undo', exact: true }).click();
  await expect(page.getByLabel('Room name', { exact: true })).toHaveValue('Studies in light');
  await page.getByRole('button', { name: 'Redo', exact: true }).click();
  await expect(page.getByLabel('Room name', { exact: true })).toHaveValue('Light and shadow');
  await page.getByRole('button', { name: 'Save and publish', exact: true }).click();
  await page
    .getByRole('dialog')
    .getByRole('button', { name: 'Save and publish', exact: true })
    .click();
  await expect(page.getByRole('heading', { name: 'Your museum is open.' })).toBeVisible();
  const visitor = await context.newPage();
  await visitor.goto('/visit');
  await expect(visitor.getByRole('heading', { name: 'Still / Life' })).toBeVisible();
  await page.getByRole('button', { name: 'Close dialog' }).click();
  await page.getByRole('button', { name: 'Museum settings' }).click();
  await page.getByLabel('Museum name', { exact: true }).fill('Another exhibition');
  await page.getByRole('button', { name: 'Save and publish', exact: true }).click();
  await page
    .getByRole('dialog')
    .getByRole('button', { name: 'Save and publish', exact: true })
    .click();
  await expect(page.getByRole('heading', { name: 'Your museum is open.' })).toBeVisible();
  await expect(visitor.getByRole('heading', { name: 'Still / Life' })).toBeVisible();
  await visitor.reload();
  await expect(visitor.getByRole('heading', { name: 'Another exhibition' })).toBeVisible();
});
test('choose a frame, change wall cells, and browse a working 3D collection', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto('/');
  await page.getByRole('button', { name: 'Wall layouts', exact: true }).click();
  await page.getByRole('button', { name: 'Select After the rain', exact: true }).click();
  await page.getByLabel('Frame style').selectOption('gold');
  await expect(page.locator('.wall-region.chosen .frame-gold')).toBeVisible();
  await page.getByRole('button', { name: 'Split vertically' }).click();
  await expect(page.getByRole('button', { name: 'Select empty wall region' })).toHaveCount(1);
  await page.getByRole('button', { name: 'Undo', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Select empty wall region' })).toHaveCount(0);
  await page.getByRole('button', { name: '3D preview', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Collection', exact: true })).toBeVisible();
  await expect(page.locator('canvas.museum-canvas')).toBeVisible();
  await page.getByRole('button', { name: 'Collection', exact: true }).click();
  await page
    .getByRole('dialog')
    .getByRole('button', { name: /After the rain/ })
    .click();
  await expect(page.getByRole('dialog').getByText(/A landscape reduced/)).toBeVisible();
  await page.getByRole('button', { name: 'Close dialog' }).click();
  await page.screenshot({ path: 'output/playwright/visitor.png' });
  expect(errors).toEqual([]);
});
test('mobile visitors can open the collection without pointer lock', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/visit');
  await page.getByRole('button', { name: 'Browse the accessible collection' }).click();
  await expect(page.getByRole('dialog', { name: 'The collection' })).toBeVisible();
  await page
    .getByRole('dialog')
    .getByRole('button', { name: /Intervals/ })
    .click();
  await expect(page.getByRole('dialog').getByText(/A study in balance/)).toBeVisible();
  await page.screenshot({ path: 'output/playwright/mobile.png' });
});
test('portrait uploads keep proportions across reloads and display variants', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('button', { name: /Art collection/ }).click();
  const data = await page.evaluate(() => {
    const canvas = document.createElement('canvas');
    canvas.width = 1000;
    canvas.height = 1500;
    const ctx = canvas.getContext('2d')!;
    ctx.fillStyle = '#879b78';
    ctx.fillRect(0, 0, 1000, 1500);
    return canvas.toDataURL('image/png').split(',')[1];
  });
  await page.locator('input[type=file]').setInputFiles({
    name: 'Portrait test.png',
    mimeType: 'image/png',
    buffer: Buffer.from(data, 'base64'),
  });
  const card = page.getByRole('button', { name: /Portrait test/ });
  await expect(card).toBeVisible();
  await expect
    .poll(async () =>
      card.locator('img').evaluate((img: HTMLImageElement) => img.naturalWidth / img.naturalHeight),
    )
    .toBeCloseTo(2 / 3, 2);
  await expect(page.getByText('All changes saved', { exact: true })).toBeVisible();
  await page.reload();
  await page.getByRole('button', { name: /Art collection/ }).click();
  await expect(card).toBeVisible();
  await expect
    .poll(async () => card.locator('img').evaluate((img: HTMLImageElement) => img.naturalHeight))
    .toBe(512);
});
test('book pages reject overflow and supported Markdown cannot execute scripts', async ({
  page,
}) => {
  await page.goto('/');
  await page.getByRole('button', { name: 'Room experiences', exact: true }).click();
  const source = page.getByRole('textbox', { name: /Page 1/ });
  await source.fill('# Welcome\n\n<script>window.hacked=true</script>\n\nA **quiet** place.');
  await expect(page.locator('.book-preview strong')).toHaveText('quiet');
  expect(await page.evaluate(() => Object.hasOwn(window, 'hacked'))).toBe(false);
  await source.fill('A long explanation. '.repeat(200));
  await expect(page.getByText(/This page may overflow/)).toBeVisible();
  await page.getByRole('button', { name: 'Save and publish', exact: true }).click();
  await expect(
    page.getByRole('dialog').getByRole('button', { name: 'Save and publish', exact: true }),
  ).toBeDisabled();
});
test('audioguide continues after closing an exhibit and cancels when disabled', async ({
  page,
}) => {
  await page.addInitScript(() => {
    const state = { spoken: [] as string[], cancelled: 0 };
    Object.defineProperty(window, 'speechSynthesis', {
      value: {
        getVoices: () => [{ lang: 'en-US' }],
        speak: (utterance: SpeechSynthesisUtterance) => state.spoken.push(utterance.text),
        cancel: () => state.cancelled++,
      },
    });
    Object.assign(window, { speechTest: state });
  });
  await page.goto('/visit');
  await page.getByRole('button', { name: 'Enter exhibition' }).click();
  await page.getByRole('button', { name: 'Audioguide off' }).click();
  await page.getByRole('button', { name: 'Collection', exact: true }).click();
  await page
    .getByRole('dialog')
    .getByRole('button', { name: /After the rain/ })
    .click();
  await page.getByRole('button', { name: 'Listen to the explanation' }).click();
  await page.getByRole('button', { name: 'Close dialog' }).click();
  await expect(page.getByRole('status').filter({ hasText: 'Now playing' })).toBeVisible();
  const before = await page.evaluate(() => (window as any).speechTest.cancelled);
  await page.getByRole('button', { name: 'Audioguide on' }).click();
  await expect(page.getByRole('status').filter({ hasText: 'Now playing' })).toHaveCount(0);
  expect(await page.evaluate(() => (window as any).speechTest.cancelled)).toBeGreaterThan(before);
});
