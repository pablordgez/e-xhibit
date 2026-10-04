import { test, expect, type Page } from '@playwright/test';

async function clickStop(
  page: Page,
  direction: 'west' | 'east' | 'north' | 'south' | 'up' | 'down',
  optional = false,
  viewingCircle = false,
) {
  const selected = await page.evaluate(
    async ({ direction, viewingCircle }) => {
      const em = '/node_modules/.vite/deps/@babylonjs_core_Engines_engine.js';
      const mm = '/node_modules/.vite/deps/@babylonjs_core_Maths_math__vector.js';
      const { Engine } = await import(em),
        { Vector3, Matrix } = await import(mm);
      const scene = Engine.LastCreatedScene,
        camera = scene.activeCamera,
        engine = scene.getEngine();
      const candidates = scene.meshes
        .filter((m: any) => {
          if (m.metadata?.kind !== 'move' || !m.isEnabled()) return false;
          const p = m.metadata.point;
          if (viewingCircle && p.route) return false;
          if (direction === 'up' || direction === 'down') return p.stairs === direction;
          if (p.stairs) return false;
          const dx = m.position.x - camera.position.x,
            dz = m.position.z - camera.position.z;
          return direction === 'west'
            ? dx < -0.9
            : direction === 'east'
              ? dx > 0.9
              : direction === 'north'
                ? dz < -0.9
                : dz > 0.9;
        })
        .sort(
          (a: any, b: any) =>
            Vector3.Distance(a.position, camera.position) -
            Vector3.Distance(b.position, camera.position),
        );
      for (const mesh of candidates) {
        const p = mesh.position;
        camera.setTarget(p);
        await new Promise<void>((r) =>
          requestAnimationFrame(() => requestAnimationFrame(() => r())),
        );
        const viewport = camera.viewport.toGlobal(
          engine.getRenderWidth(),
          engine.getRenderHeight(),
        );
        const projected = Vector3.Project(
          p,
          Matrix.Identity(),
          scene.getTransformMatrix(),
          viewport,
        );
        const x = projected.x * engine.getHardwareScalingLevel(),
          y = projected.y * engine.getHardwareScalingLevel();
        if (scene.pick(x, y)?.pickedMesh !== mesh) continue;
        const rect = engine.getRenderingCanvas().getBoundingClientRect();
        const target = mesh.metadata.point.stairs
          ? mesh.metadata.point.route.at(-1)
          : mesh.metadata.point;
        return { x: x + rect.left, y: y + rect.top, target, label: mesh.metadata.label };
      }
      return null;
    },
    { direction, viewingCircle },
  );
  if (!selected && optional) return false;
  expect(selected, `a visible, unobstructed ${direction} floor circle`).not.toBeNull();
  await page.mouse.click(selected!.x, selected!.y);
  await expect
    .poll(
      async () =>
        page.evaluate(async (target) => {
          const module = '/node_modules/.vite/deps/@babylonjs_core_Engines_engine.js';
          const { Engine } = await import(module);
          const p = Engine.LastCreatedScene.activeCamera.position;
          return Math.hypot(p.x - target.x, p.y - 1.65 - target.y, p.z - target.z);
        }, selected!.target),
      // Animated movement caps each frame's step, so low-FPS software WebGL takes
      // more wall-clock time without changing the destination or path assertions.
      { timeout: viewingCircle ? 30000 : 10000 },
    )
    .toBeLessThan(0.1);
  return true;
}

async function enter(page: Page) {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.goto('/visit');
  await page.getByRole('button', { name: 'Enter exhibition', exact: true }).click();
  await expect(page.locator('canvas.museum-canvas')).toBeVisible();
}

test('the corridor and regular staircase can be visited using only floor circles', async ({
  page,
}) => {
  await enter(page);
  for (let i = 0; i < 7; i++) {
    if ((await page.locator('.location-pill strong').textContent()) === 'The reading room') break;
    await clickStop(page, 'west');
  }
  await expect(page.locator('.location-pill strong')).toHaveText('The reading room');
  for (let i = 0; i < 7; i++) {
    if ((await page.locator('.location-pill strong').textContent()) === 'The welcome room') break;
    await clickStop(page, 'east');
  }
  await clickStop(page, 'up');
  await expect(page.locator('.location-pill strong')).toHaveText('The upper landing');
  await clickStop(page, 'down');
  await expect(page.locator('.location-pill strong')).toHaveText('The welcome room');
});

test('the shop and spiral staircase can be visited using only floor circles', async ({ page }) => {
  await enter(page);
  for (let i = 0; i < 5; i++) {
    if ((await page.locator('.location-pill strong').textContent()) === 'Studies in light') break;
    await clickStop(page, 'north');
  }
  for (let i = 0; i < 10; i++) {
    if ((await page.locator('.location-pill strong').textContent()) === 'The museum shop') break;
    await clickStop(page, 'east');
  }
  await expect(page.locator('.location-pill strong')).toHaveText('The museum shop');
  // Continue around the shaft until the stair entrance itself is visible.
  for (let i = 0; i < 4; i++) {
    if (await clickStop(page, 'up', true)) break;
    await clickStop(page, 'east');
  }
  await expect(page.locator('.location-pill strong')).toHaveText('A different perspective');
  await page.evaluate(async () => {
    const module = '/node_modules/.vite/deps/@babylonjs_core_Engines_engine.js';
    const { Engine } = await import(module);
    const camera = Engine.LastCreatedScene.activeCamera;
    camera.rotation.y = Math.PI / 2;
    camera.rotation.x = -0.6;
    await new Promise<void>((resolve) =>
      requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
    );
  });
  await page.screenshot({ path: 'output/playwright/spiral-landing-connected.png' });
  await clickStop(page, 'down');
  await expect(page.locator('.location-pill strong')).toHaveText('The museum shop');
});

test('animated travel to a viewing circle never reverses or overshoots', async ({ page }) => {
  test.slow();
  await enter(page);
  await page
    .getByRole('navigation', { name: 'Nearby destinations' })
    .getByRole('button', { name: 'Studies in light', exact: true })
    .click();
  await expect(page.locator('.location-pill strong')).toHaveText('Studies in light');
  await clickStop(page, 'east');
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  await page.evaluate(async () => {
    const module = '/node_modules/.vite/deps/@babylonjs_core_Engines_engine.js';
    const { Engine } = await import(module);
    const scene = Engine.LastCreatedScene;
    (window as any).travelSamples = [];
    scene.onAfterRenderObservable.add(() =>
      (window as any).travelSamples.push(scene.activeCamera.position.x),
    );
  });
  await clickStop(page, 'east', false, true);
  const samples: number[] = await page.evaluate(() => (window as any).travelSamples);
  expect(samples.length).toBeGreaterThan(5);
  for (let i = 1; i < samples.length; i++) {
    expect(samples[i]).toBeGreaterThanOrEqual(samples[i - 1] - 0.001);
    expect(samples[i]).toBeLessThanOrEqual(6.001);
  }
  expect(samples.at(-1)).toBeGreaterThan(5.9);
});
