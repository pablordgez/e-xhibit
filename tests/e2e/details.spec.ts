import { test, expect, type Page } from '@playwright/test';

async function aimAt(page: Page, name: string, asset?: string) {
  return page.evaluate(
    async ({ name, asset }) => {
      const engineModule = '/node_modules/.vite/deps/@babylonjs_core_Engines_engine.js';
      const mathModule = '/node_modules/.vite/deps/@babylonjs_core_Maths_math__vector.js';
      const { Engine } = await import(engineModule),
        { Vector3, Matrix } = await import(mathModule);
      const scene = Engine.LastCreatedScene,
        camera = scene.activeCamera,
        engine = scene.getEngine();
      const target = scene.meshes.find(
        (m: any) => m.name === name && (!asset || m.metadata?.id === asset),
      ).position;
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
    },
    { name, asset },
  );
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

test('artwork labels are sharp and skirting joins doorway walls and corridors', async ({
  page,
}) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.goto('/visit');
  await page.getByRole('button', { name: 'Enter exhibition', exact: true }).click();
  await page
    .getByRole('navigation', { name: 'Nearby destinations' })
    .getByRole('button', { name: 'Studies in light', exact: true })
    .click();
  await expect(page.locator('.location-pill strong')).toHaveText('Studies in light');
  await aimAt(page, 'explanation');
  await expect
    .poll(async () =>
      page.evaluate(async () => {
        const module = '/node_modules/.vite/deps/@babylonjs_core_Engines_engine.js';
        const { Engine } = await import(module);
        return Engine.LastCreatedScene.getEngine().getHardwareScalingLevel();
      }),
    )
    .toBe(1);
  await page.screenshot({ path: 'output/playwright/readable-artwork-label.png' });
  const result = await page.evaluate(async () => {
    const module = '/node_modules/.vite/deps/@babylonjs_core_Engines_engine.js';
    const { Engine } = await import(module);
    const scene = Engine.LastCreatedScene;
    const p = scene.getMeshByName('explanation');
    const size = p.material.diffuseTexture.getSize();
    const b = p.getBoundingInfo().boundingBox.extendSize;
    const trim = scene.meshes.filter((m: any) => m.name === 'skirting');
    return {
      resolution: size.width,
      ratio: size.width / size.height,
      physicalRatio: b.x / b.y,
      doorSides: trim.filter(
        (m: any) =>
          Math.abs(m.position.z + 3) < 0.01 &&
          Math.abs(m.position.x) > 1 &&
          Math.abs(m.position.x) < 3,
      ).length,
      corridor: trim.some((m: any) => m.position.x < -3 && m.position.x > -9),
      mergedJoin: trim
        .filter((m: any) => Math.abs(m.position.z + 9) < 0.01 && [0, 6].includes(m.position.x))
        .every((m: any) => m.getBoundingInfo().boundingBox.extendSize.x >= 3),
    };
  });
  expect(result.resolution).toBeGreaterThanOrEqual(1536);
  expect(result.ratio).toBeCloseTo(result.physicalRatio, 2);
  expect(result.doorSides).toBeGreaterThanOrEqual(2);
  expect(result.corridor).toBe(true);
  expect(result.mergedJoin).toBe(true);
});

test('the corridor-end artwork and its label face visitors without mirroring', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.goto('/visit');
  await page.getByRole('button', { name: 'Enter exhibition', exact: true }).click();
  await page
    .getByRole('navigation', { name: 'Nearby destinations' })
    .getByRole('button', { name: 'The reading room', exact: true })
    .click();
  await expect(page.locator('.location-pill strong')).toHaveText('The reading room');
  await aimAt(page, 'explanation', 'art-6');
  await expect
    .poll(async () =>
      page.evaluate(async () => {
        const module = '/node_modules/.vite/deps/@babylonjs_core_Engines_engine.js';
        const { Engine } = await import(module);
        const s = Engine.LastCreatedScene;
        return Boolean(s.getMeshByName('art-exhibit-5').material.diffuseTexture?.isReady());
      }),
    )
    .toBe(true);
  await page.screenshot({ path: 'output/playwright/reading-room-orientation.png' });
  const fronts = await page.evaluate(async () => {
    const module = '/node_modules/.vite/deps/@babylonjs_core_Engines_engine.js';
    const math = '/node_modules/.vite/deps/@babylonjs_core_Maths_math__vector.js';
    const { Engine } = await import(module),
      { Vector3 } = await import(math);
    return Engine.LastCreatedScene.meshes
      .filter((m: any) => m.metadata?.id === 'art-6' && m.position.x < -10)
      .map((m: any) => m.getDirection(new Vector3(0, 0, -1)).x);
  });
  expect(fronts).toHaveLength(2);
  for (const x of fronts) expect(x).toBeGreaterThan(0.99);
});
