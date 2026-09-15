import { test, expect, type Page } from '@playwright/test';

async function aimAt(page: Page, name: string) {
  return page.evaluate(async (name) => {
    const engineModule = '/node_modules/.vite/deps/@babylonjs_core_Engines_engine.js';
    const mathModule = '/node_modules/.vite/deps/@babylonjs_core_Maths_math__vector.js';
    const { Engine } = await import(engineModule),
      { Vector3, Matrix } = await import(mathModule);
    const scene = Engine.LastCreatedScene,
      camera = scene.activeCamera,
      engine = scene.getEngine();
    const target = scene.getMeshByName(name).position;
    camera.rotation.y = Math.atan2(target.x - camera.position.x, target.z - camera.position.z);
    camera.rotation.x = -Math.atan2(
      target.y - camera.position.y,
      Math.hypot(target.x - camera.position.x, target.z - camera.position.z),
    );
    await new Promise<void>((resolve) =>
      requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
    );
    const viewport = camera.viewport.toGlobal(engine.getRenderWidth(), engine.getRenderHeight());
    const p = Vector3.Project(target, Matrix.Identity(), scene.getTransformMatrix(), viewport);
    const rect = engine.getRenderingCanvas().getBoundingClientRect();
    return {
      x: rect.left + p.x * engine.getHardwareScalingLevel(),
      y: rect.top + p.y * engine.getHardwareScalingLevel(),
    };
  }, name);
}

test('information and download signs are identifiable, clickable 3D objects', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.goto('/visit');
  await page.getByRole('button', { name: 'Enter exhibition', exact: true }).click();
  await expect(page.locator('canvas.museum-canvas')).toBeVisible();
  const info = await aimAt(page, 'sign-info');
  await page.screenshot({ path: 'output/playwright/information-booth.png' });
  await page.mouse.click(info.x, info.y);
  await expect(page.getByRole('dialog', { name: 'The welcome room' })).toBeVisible();
  await page.getByRole('button', { name: 'Close dialog' }).click();
  const destinations = page.getByRole('navigation', { name: 'Nearby destinations' });
  await destinations
    .getByRole('button', { name: 'Upstairs · The upper landing', exact: true })
    .click();
  await expect(page.locator('.location-pill strong')).toHaveText('The upper landing');
  await aimAt(page, 'closed-stair-tread');
  await page.screenshot({ path: 'output/playwright/regular-staircase.png' });
  await destinations
    .getByRole('button', { name: 'Downstairs · The welcome room', exact: true })
    .click();
  await expect(page.locator('.location-pill strong')).toHaveText('The welcome room');
  for (const name of ['Studies in light', 'The open landscape', 'The museum shop']) {
    await page
      .getByRole('navigation', { name: 'Nearby destinations' })
      .getByRole('button', { name, exact: true })
      .click();
    await expect(page.locator('.location-pill strong')).toHaveText(name);
  }
  await aimAt(page, 'spiral-support-column');
  await page.screenshot({ path: 'output/playwright/spiral-staircase.png' });
  const kiosk = await aimAt(page, 'sign-download');
  await page.screenshot({ path: 'output/playwright/download-kiosk.png' });
  await page.mouse.click(kiosk.x, kiosk.y);
  await expect(page.getByRole('dialog', { name: 'Download collection' })).toBeVisible();
  const geometry = await page.evaluate(async () => {
    const module = '/node_modules/.vite/deps/@babylonjs_core_Engines_engine.js';
    const { Engine } = await import(module);
    const s = Engine.LastCreatedScene;
    const shelves = s.meshes.filter((m: any) => m.name === 'shop-shelf');
    const prints = s.meshes.filter((m: any) => m.name === 'shop-print');
    return {
      ceilings: s.meshes.filter((m: any) => m.name === 'ceiling').length,
      lights: s.meshes.filter((m: any) => m.name === 'ceiling-light').length,
      printsRestOnShelves: prints.every((p: any) =>
        shelves.some((s: any) => {
          const bottom = p.getBoundingInfo().boundingBox.minimumWorld.y;
          const top = s.getBoundingInfo().boundingBox.maximumWorld.y;
          return (
            Math.hypot(p.position.x - s.position.x, p.position.z - s.position.z) < 0.75 &&
            Math.abs(bottom - top - 0.02) < 0.005
          );
        }),
      ),
    };
  });
  expect(geometry.ceilings).toBeGreaterThan(8);
  expect(geometry.lights).toBeGreaterThan(8);
  expect(geometry.printsRestOnShelves).toBe(true);
  expect(errors).toEqual([]);
});

test('an ordinary gift shop has freestanding displays and greenery', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.goto('/');
  await page.getByRole('button', { name: /The reading room/ }).click();
  await page.getByRole('combobox', { name: 'Room type', exact: true }).selectOption('shop');
  await expect(page.getByRole('button', { name: 'Ready to publish', exact: true })).toBeVisible();
  await page.getByRole('button', { name: '3D preview', exact: true }).click();
  await page
    .getByRole('navigation', { name: 'Nearby destinations' })
    .getByRole('button', { name: 'The reading room', exact: true })
    .click();
  await expect(page.locator('.location-pill strong')).toHaveText('The reading room');
  await aimAt(page, 'shop-display-table');
  await page.screenshot({ path: 'output/playwright/furnished-gift-shop.png' });
  const objects = await page.evaluate(async () => {
    const module = '/node_modules/.vite/deps/@babylonjs_core_Engines_engine.js';
    const { Engine } = await import(module);
    return Engine.LastCreatedScene.meshes.map((m: any) => m.name);
  });
  expect(objects).toEqual(
    expect.arrayContaining([
      'shop-display-table',
      'shop-planter',
      'catalog-stack',
      'kiosk-screen-housing',
    ]),
  );
});
