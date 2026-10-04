import { test, expect, type Page } from '@playwright/test';

// Read the real Babylon camera; inputs below remain browser keyboard/mouse events.
async function camera(page: Page) {
  return page.evaluate(async () => {
    const module = '/node_modules/.vite/deps/@babylonjs_core_Engines_engine.js';
    const { Engine } = await import(module);
    const c = Engine.LastCreatedScene?.activeCamera;
    return c ? { x: c.position.x, y: c.position.y, z: c.position.z, yaw: c.rotation.y } : null;
  });
}
async function enter(page: Page) {
  await page.goto('/visit');
  await page.getByRole('button', { name: 'Enter exhibition', exact: true }).click();
  await expect.poll(() => camera(page)).not.toBeNull();
}

test('WASD moves on both axes and FPS mouse look works without dragging', async ({ page }) => {
  // Eight real keyboard/camera round trips are slower with software WebGL on CI.
  test.setTimeout(180000);
  await page.setViewportSize({ width: 960, height: 600 });
  await enter(page);
  await page.getByRole('button', { name: 'Walk', exact: true }).click();
  await page.getByRole('button', { name: /Start walking/ }).click();
  await expect.poll(() => page.evaluate(() => Boolean(document.pointerLockElement))).toBe(true);
  // Flush Chromium's asynchronous cursor warp through rendered frames before
  // establishing the heading. Pointer lock itself becomes true before this event.
  await page.mouse.move(480, 300);
  await page.evaluate(
    () =>
      new Promise<void>((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
      ),
  );
  // Headless Chromium can warp the virtual cursor when locking it. Establish the
  // heading used by the axis assertions after that browser-generated mouse event.
  await page.evaluate(async () => {
    const module = '/node_modules/.vite/deps/@babylonjs_core_Engines_engine.js';
    const { Engine } = await import(module);
    Engine.LastCreatedScene.activeCamera.rotation.set(0, 0, 0);
  });
  await expect.poll(async () => (await camera(page))!.yaw).toBe(0);
  for (const [key, axis, direction] of [
    ['a', 'x', -1],
    ['d', 'x', 1],
    ['w', 'z', -1],
    ['s', 'z', 1],
  ] as const) {
    const before = (await camera(page))!;
    await page.keyboard.down(key);
    await expect
      .poll(async () => ((await camera(page))![axis] - before[axis]) * direction, {
        timeout: 30000,
      })
      .toBeGreaterThan(0.35);
    await page.keyboard.up(key);
  }
  // After turning east, forward follows +X and screen-right follows +Z.
  await page.evaluate(async () => {
    const module = '/node_modules/.vite/deps/@babylonjs_core_Engines_engine.js';
    const { Engine } = await import(module);
    Engine.LastCreatedScene.activeCamera.rotation.y = -Math.PI / 2;
  });
  for (const [key, axis, direction] of [
    ['a', 'z', -1],
    ['d', 'z', 1],
    ['w', 'x', 1],
    ['s', 'x', -1],
  ] as const) {
    const before = (await camera(page))!;
    await page.keyboard.down(key);
    await expect
      .poll(async () => ((await camera(page))![axis] - before[axis]) * direction, {
        timeout: 30000,
      })
      .toBeGreaterThan(0.35);
    await page.keyboard.up(key);
  }
  const before = (await camera(page))!;
  // Observe the real camera after the application's trusted pointer-event handler.
  // Headless cursor recentering can cancel the net rotation of a whole gesture.
  await page.evaluate(async (yaw) => {
    const module = '/node_modules/.vite/deps/@babylonjs_core_Engines_engine.js';
    const { Engine } = await import(module);
    const canvas = document.querySelector('canvas.museum-canvas')!;
    (window as any).mouseLookRotations = [];
    canvas.addEventListener('pointermove', (event) => {
      if (event.isTrusted && document.pointerLockElement === canvas)
        (window as any).mouseLookRotations.push(
          Math.abs(Engine.LastCreatedScene.activeCamera.rotation.y - yaw),
        );
    });
  }, before.yaw);
  for (const x of [540, 590, 640, 690]) {
    await page.mouse.move(x, 320);
  }
  await expect
    .poll(() => page.evaluate(() => Math.max(0, ...(window as any).mouseLookRotations)))
    .toBeGreaterThan(0.05);
  await page.evaluate(() => document.exitPointerLock());
  await expect(page.getByRole('button', { name: /Start walking/ })).toBeVisible();
  await page.getByRole('button', { name: 'Collection', exact: true }).click();
  await expect(page.getByRole('dialog')).toBeVisible();
});

test('the center of a nearby floor circle is clickable at reduced render resolution', async ({
  page,
}) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await enter(page);
  // Exercise exactly the scaling that previously displaced picks on mobile/slow GPUs.
  await page.evaluate(async () => {
    const module = '/node_modules/.vite/deps/@babylonjs_core_Engines_engine.js';
    const { Engine } = await import(module);
    Engine.LastCreatedScene.getEngine().setHardwareScalingLevel(2);
  });
  const destination = await page.evaluate(async () => {
    const engineModule = '/node_modules/.vite/deps/@babylonjs_core_Engines_engine.js';
    const mathsModule = '/node_modules/.vite/deps/@babylonjs_core_Maths_math__vector.js';
    const { Engine } = await import(engineModule),
      { Vector3, Matrix } = await import(mathsModule);
    const scene = Engine.LastCreatedScene,
      engine = scene.getEngine(),
      c = scene.activeCamera;
    const bounds = engine.getRenderingCanvas().getBoundingClientRect();
    const viewport = c.viewport.toGlobal(engine.getRenderWidth(), engine.getRenderHeight());
    for (const mesh of scene.meshes.filter(
      (m: any) => m.metadata?.kind === 'move' && m.isEnabled(),
    )) {
      const p = Vector3.Project(
        mesh.position,
        Matrix.Identity(),
        scene.getTransformMatrix(),
        viewport,
      );
      const x = p.x * engine.getHardwareScalingLevel(),
        y = p.y * engine.getHardwareScalingLevel();
      if (x < 40 || x > bounds.width - 40 || y < 110 || y > bounds.height - 160 || p.z > 1)
        continue;
      if (scene.pick(x, y)?.pickedMesh !== mesh) continue;
      return { x: x + bounds.left, y: y + bounds.top, point: mesh.metadata.point };
    }
    return null;
  });
  expect(destination, 'a visible nearby destination with a filled center').not.toBeNull();
  await page.mouse.click(destination!.x, destination!.y);
  await expect
    .poll(async () => {
      const c = (await camera(page))!;
      return Math.hypot(c.x - destination!.point.x, c.z - destination!.point.z);
    })
    .toBeLessThan(0.1);
  await page.screenshot({ path: 'output/playwright/navigation-circles.png' });
});

test('a room cannot be placed across an existing stair bay', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('button', { name: 'Add room', exact: true }).click();
  await page.getByRole('button', { name: 'Place room at 1, 0', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('staircase needs clear space');
  await expect(page.getByRole('button', { name: 'Ready to publish', exact: true })).toBeVisible();
});

test('guided visitors can enter and leave the shop, and ascend and descend both stair types', async ({
  page,
}) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await enter(page);
  const links = page.getByRole('navigation', { name: 'Nearby destinations' });
  const go = async (name: string, room: string) => {
    await links.getByRole('button', { name, exact: true }).click();
    await expect(page.locator('.location-pill strong')).toHaveText(room);
  };
  await go('Studies in light', 'Studies in light');
  await go('The open landscape', 'The open landscape');
  await go('The museum shop', 'The museum shop');
  expect((await camera(page))!.x).toBeCloseTo(14.4, 1);
  await page.screenshot({ path: 'output/playwright/shop-navigation.png' });
  await go('Upstairs · A different perspective', 'A different perspective');
  expect((await camera(page))!.y).toBeCloseTo(5.65, 1);
  await go('Downstairs · The museum shop', 'The museum shop');
  expect((await camera(page))!.y).toBeCloseTo(1.65, 1);
  await go('The open landscape', 'The open landscape');
  await go('Studies in light', 'Studies in light');
  await go('The welcome room', 'The welcome room');
  await go('Upstairs · The upper landing', 'The upper landing');
  expect((await camera(page))!.y).toBeCloseTo(5.65, 1);
  await go('Downstairs · The welcome room', 'The welcome room');
  expect((await camera(page))!.y).toBeCloseTo(1.65, 1);
});
