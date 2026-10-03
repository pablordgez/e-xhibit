import { expect, test } from '@playwright/test';
import { sample } from '../../src/core/sample';
import { fitExhibit } from '../../src/core/exhibits';

test('split artwork grows with automatic labels and the elevation matches the 3D preview', async ({
  page,
}) => {
  const doc = structuredClone(sample);
  doc.rooms = [{ ...doc.rooms[0], kind: 'gallery' }];
  doc.connections = [];
  doc.assets = [{ ...doc.assets[0], title: 'After the rain', explanation: '', attribution: '' }];
  doc.regions = [{ ...doc.regions[0], wall: 'welcome:north', x: 0.3, y: 0.5, w: 5.4, h: 2.8 }];
  await page.addInitScript((document) => {
    localStorage.setItem(
      'exhibit-draft-v1',
      JSON.stringify({ document, revision: 0, publication: null }),
    );
  }, doc);
  await page.goto('/');
  await page.getByRole('button', { name: 'Wall layouts', exact: true }).click();
  const artwork = page.getByRole('button', { name: 'Select After the rain', exact: true });
  await artwork.click();
  const placement = page.getByLabel('Explanation plaque', { exact: true });
  await expect(placement).toHaveValue('auto');
  await page.getByRole('button', { name: 'Split horizontally', exact: true }).click();
  await expect(artwork.locator('.exhibit-layout')).toHaveAttribute('data-plaque-side', 'right');
  const auto = await artwork.locator('.framed-image').boundingBox();
  await placement.selectOption('below');
  await expect(artwork.locator('.exhibit-layout')).toHaveAttribute('data-plaque-side', 'below');
  const below = await artwork.locator('.framed-image').boundingBox();
  expect(auto!.width * auto!.height).toBeGreaterThan(below!.width * below!.height * 1.15);
  await placement.selectOption('auto');
  await expect(page.getByText('All changes saved', { exact: true })).toBeVisible();
  const saved = await page.evaluate(
    () => JSON.parse(localStorage.getItem('exhibit-draft-v1')!).document,
  );
  const r = saved.regions.find((r: any) => r.assetId);
  const fit = fitExhibit(
    r,
    doc.assets[0].width / doc.assets[0].height,
    doc.defaultFrame,
    doc.assets[0],
  );
  const regionBox = (await artwork.locator('.exhibit-layout').boundingBox())!;
  const imageBox = (await artwork.locator('.framed-image').boundingBox())!;
  const plaqueBox = (await artwork.locator('.mini-plaque').boundingBox())!;
  expect(imageBox.width / regionBox.width).toBeCloseTo((fit.w + fit.border * 2) / r.w, 2);
  expect(imageBox.height / regionBox.height).toBeCloseTo((fit.h + fit.border * 2) / r.h, 2);
  expect(plaqueBox.height / regionBox.height).toBeCloseTo(fit.plaque!.h / r.h, 2);
  await page.screenshot({ path: 'output/playwright/automatic-exhibit-layout.png' });
  await page.getByRole('button', { name: '3D preview', exact: true }).click();
  await expect(page.locator('canvas.museum-canvas')).toBeVisible();
  const geometry = await page.evaluate(async (id) => {
    const module = '/node_modules/.vite/deps/@babylonjs_core_Engines_engine.js';
    const { Engine } = await import(module);
    const scene = Engine.LastCreatedScene;
    const image = scene.getMeshByName(`art-${id}`),
      card = scene.getMeshByName('explanation');
    const size = (mesh: any) => {
      const b = mesh.getBoundingInfo().boundingBox;
      return {
        w: b.maximum.x - b.minimum.x,
        h: b.maximum.y - b.minimum.y,
        x: mesh.position.x + 3,
        y: mesh.position.y,
      };
    };
    return { image: size(image), card: size(card) };
  }, r.id);
  expect(geometry.image.w).toBeCloseTo(fit.w);
  expect(geometry.image.h).toBeCloseTo(fit.h);
  expect(geometry.image.x).toBeCloseTo(fit.image.x);
  expect(geometry.image.y).toBeCloseTo(fit.image.y);
  expect(geometry.card.w).toBeCloseTo(fit.plaque!.w);
  expect(geometry.card.h).toBeCloseTo(fit.plaque!.h);
  expect(geometry.card.x).toBeCloseTo(fit.plaque!.x);
  expect(geometry.card.y).toBeCloseTo(fit.plaque!.y);
});
