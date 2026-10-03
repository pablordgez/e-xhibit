import { test, expect, type Page } from '@playwright/test';

async function picker(page: Page) {
  await page.getByRole('button', { name: 'Wall layouts', exact: true }).click();
  await page.getByRole('button', { name: 'Select After the rain', exact: true }).click();
  await page.getByRole('button', { name: 'Change artwork', exact: true }).click();
  return page.getByRole('dialog', { name: 'Choose an artwork', exact: true });
}

test('the visual picker searches photos, selects a work, clears a region and restores keyboard focus', async ({
  page,
}) => {
  await page.goto('/');
  let dialog = await picker(page);
  await expect(dialog.locator('.art-card img')).toHaveCount(6);
  await dialog.getByRole('textbox', { name: 'Search collection' }).fill('water rests');
  await expect(dialog.getByRole('button', { name: /^Choose / })).toHaveCount(1);
  await dialog.getByRole('button', { name: 'Choose Where the water rests', exact: true }).click();
  await expect(dialog).not.toBeVisible();
  await expect(
    page.getByRole('button', { name: 'Select Where the water rests', exact: true }),
  ).toBeVisible();
  await expect(page.getByRole('button', { name: 'Change artwork', exact: true })).toBeFocused();
  await page.getByRole('button', { name: 'Change artwork', exact: true }).click();
  dialog = page.getByRole('dialog', { name: 'Choose an artwork' });
  await page.screenshot({ path: 'output/playwright/artwork-picker.png' });
  await dialog.getByRole('button', { name: 'Leave region empty', exact: true }).click();
  await expect(
    page.getByRole('button', { name: 'Select empty wall region', exact: true }),
  ).toBeVisible();
  await page.getByRole('button', { name: 'Choose artwork', exact: true }).click();
  await page.keyboard.press('Escape');
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Choose artwork', exact: true })).toBeFocused();
});

test('categories persist, filter the inventory and picker, and can be renamed or removed', async ({
  page,
}) => {
  await page.goto('/');
  const selection = await picker(page);
  await expect(selection.getByText(/To upload new artwork/)).toBeVisible();
  await selection.getByRole('link', { name: 'Art collection ↗' }).click();
  await expect(page.getByRole('heading', { name: 'Artwork inventory' })).toBeVisible();
  await page.getByRole('button', { name: 'Manage categories' }).click();
  let categories = page.getByRole('dialog', { name: 'Collection categories' });
  await categories.getByLabel('New category').fill('Landscapes');
  await categories.getByRole('button', { name: 'Create category', exact: true }).click();
  await categories.getByLabel('New category').fill('Blue studies');
  await categories.getByRole('button', { name: 'Create category', exact: true }).click();
  await categories.getByRole('button', { name: 'Close dialog' }).click();
  await page.locator('.art-card').filter({ hasText: 'After the rain' }).click();
  const details = page.getByRole('dialog', { name: 'Artwork details' });
  await details.getByRole('checkbox', { name: 'Landscapes', exact: true }).check();
  await details.getByRole('checkbox', { name: 'Blue studies', exact: true }).check();
  await details.getByRole('button', { name: 'Close dialog' }).click();
  await page.getByLabel('Filter by category').selectOption({ label: 'Landscapes' });
  await expect(page.locator('.art-card')).toHaveCount(1);
  await page.getByLabel('Search collection').fill('unmatched query');
  await expect(page.getByText('No artworks match these filters.')).toBeVisible();
  await page.getByLabel('Search collection').fill('');
  await expect(page.getByText('All changes saved', { exact: true })).toBeVisible();
  await page.reload();
  await page.getByRole('button', { name: /^Art collection/ }).click();
  await page.getByLabel('Filter by category').selectOption({ label: 'Blue studies' });
  await expect(page.locator('.art-card')).toHaveCount(1);
  await page.screenshot({ path: 'output/playwright/collection-categories.png' });
  await page.getByRole('button', { name: 'Museum builder', exact: true }).click();
  const browse = await picker(page);
  await browse.getByLabel('Filter by category').selectOption({ label: 'Landscapes' });
  await expect(browse.getByRole('button', { name: /^Choose / })).toHaveCount(1);
  await browse.getByRole('link', { name: 'Art collection ↗' }).click();
  await page.getByRole('button', { name: 'Manage categories' }).click();
  categories = page.getByRole('dialog', { name: 'Collection categories' });
  const row = categories
    .locator('.category-row')
    .filter({ has: page.getByLabel('Category name: Landscapes', { exact: true }) });
  await row.getByRole('textbox').fill('Outdoor works');
  await row.getByRole('button', { name: 'Rename', exact: true }).click();
  await categories
    .getByRole('button', { name: 'Delete category Outdoor works', exact: true })
    .click();
  await categories.getByRole('button', { name: 'Close dialog' }).click();
  await page.getByLabel('Filter by category').selectOption({ label: 'Blue studies' });
  await expect(page.locator('.art-card')).toHaveCount(1);
  await page.locator('.art-card').click();
  await expect(details.getByRole('checkbox', { name: 'Blue studies' })).toBeChecked();
  await expect(details.getByRole('checkbox', { name: 'Outdoor works' })).toHaveCount(0);
});

test('the scrollwheel zooms in both modes without changing position or scrolling the page', async ({
  page,
}) => {
  await page.goto('/visit');
  await page.getByRole('button', { name: 'Enter exhibition', exact: true }).click();
  const canvas = page.locator('canvas.museum-canvas');
  await expect(canvas).toBeVisible();
  const pose = () =>
    page.evaluate(async () => {
      const module = '/node_modules/.vite/deps/@babylonjs_core_Engines_engine.js';
      const { Engine } = await import(module);
      const c = Engine.LastCreatedScene.activeCamera;
      return {
        fov: c.fov,
        x: c.position.x,
        y: c.position.y,
        z: c.position.z,
        scroll: window.scrollY,
      };
    });
  const before = await pose();
  await canvas.hover();
  await page.mouse.wheel(0, -500);
  await expect.poll(async () => (await pose()).fov).toBeLessThan(before.fov - 0.1);
  await page.mouse.wheel(0, 500);
  await expect.poll(async () => (await pose()).fov).toBeGreaterThan(before.fov - 0.03);
  await page.getByRole('button', { name: 'Walk', exact: true }).click();
  await page.getByRole('button', { name: /Start walking/ }).click();
  await expect.poll(() => page.evaluate(() => Boolean(document.pointerLockElement))).toBe(true);
  await page.mouse.wheel(0, -500);
  await expect.poll(async () => (await pose()).fov).toBeLessThan(before.fov - 0.1);
  const after = await pose();
  expect({ ...after, fov: 0 }).toEqual({ ...before, fov: 0 });
  await page.evaluate(() => document.exitPointerLock());
  await expect.poll(() => page.evaluate(() => Boolean(document.pointerLockElement))).toBe(false);
  await page.getByRole('button', { name: 'Collection', exact: true }).click();
  await expect(page.getByRole('dialog', { name: 'The collection' })).toBeVisible();
  const paused = await pose();
  await canvas.dispatchEvent('wheel', { deltaY: -120 });
  expect((await pose()).fov).toBe(paused.fov);
});
