import { test, expect } from '@playwright/test';
import { sample } from '../../src/core/sample';

test('the preview keeps the floor plan east to the right when facing north', async ({ page }) => {
  await page.goto('/');
  const light = await page
    .getByRole('button', { name: 'Studies in light', exact: true })
    .boundingBox();
  const landscape = await page
    .getByRole('button', { name: 'The open landscape', exact: true })
    .boundingBox();
  expect(landscape!.x).toBeGreaterThan(light!.x);
  await page.getByRole('button', { name: '3D preview', exact: true }).click();
  await expect(page.locator('canvas.museum-canvas')).toBeVisible();
  const projection = await page.evaluate(async () => {
    const em = '/node_modules/.vite/deps/@babylonjs_core_Engines_engine.js';
    const mm = '/node_modules/.vite/deps/@babylonjs_core_Maths_math__vector.js';
    const { Engine } = await import(em),
      { Vector3, Matrix } = await import(mm);
    const scene = Engine.LastCreatedScene,
      camera = scene.activeCamera;
    const viewport = camera.viewport.toGlobal(1000, 1000);
    const project = (x: number, z: number) =>
      Vector3.Project(
        new Vector3(x, 1.65, z),
        Matrix.Identity(),
        scene.getTransformMatrix(),
        viewport,
      ).x;
    return {
      north: camera.getForwardRay().direction.z,
      light: project(0, -6),
      landscape: project(6, -6),
    };
  });
  expect(projection.north).toBeLessThan(-0.99);
  expect(projection.landscape).toBeGreaterThan(projection.light);
});

test('artwork, labels and right-hand plaques read left to right on every wall', async ({
  page,
}) => {
  const doc = structuredClone(sample);
  doc.rooms = [{ ...doc.rooms[0], kind: 'gallery' }];
  doc.connections = [];
  doc.regions = ['north', 'east', 'south', 'west'].map((side, i) => ({
    id: `orientation-${side}`,
    wall: `welcome:${side}`,
    assetId: doc.assets[i].id,
    x: 0.3,
    y: 0.5,
    w: 5.4,
    h: 2.8,
    plaque: 'right',
  }));
  await page.addInitScript((document) => {
    localStorage.setItem(
      'exhibit-draft-v1',
      JSON.stringify({ document, revision: 0, publication: null }),
    );
  }, doc);
  await page.goto('/');
  await page.getByRole('button', { name: '3D preview', exact: true }).click();
  await expect(page.locator('canvas.museum-canvas')).toBeVisible();
  const walls = await page.evaluate(async () => {
    const em = '/node_modules/.vite/deps/@babylonjs_core_Engines_engine.js';
    const mm = '/node_modules/.vite/deps/@babylonjs_core_Maths_math__vector.js';
    const { Engine } = await import(em),
      { Vector3 } = await import(mm);
    const scene = Engine.LastCreatedScene,
      camera = scene.activeCamera;
    return ['north', 'east', 'south', 'west'].map((side) => {
      const art = scene.getMeshByName(`art-orientation-${side}`);
      const plaque = scene.meshes.find(
        (m: any) => m.name === 'explanation' && m.metadata.id === art.metadata.id,
      );
      camera.setTarget(art.position);
      const transform = camera.getViewMatrix(true).multiply(camera.getProjectionMatrix(true));
      const project = (mesh: any, point: any) =>
        Vector3.Project(
          point,
          mesh.computeWorldMatrix(true),
          transform,
          camera.viewport.toGlobal(1000, 1000),
        ).x;
      const readable = (mesh: any) => {
        const positions = mesh.getVerticesData('position'),
          uv = mesh.getVerticesData('uv');
        const left = uv.findIndex((u: number, i: number) => i % 2 === 0 && u === 0) / 2;
        const right = uv.findIndex((u: number, i: number) => i % 2 === 0 && u === 1) / 2;
        return (
          project(mesh, Vector3.FromArray(positions, right * 3)) >
          project(mesh, Vector3.FromArray(positions, left * 3))
        );
      };
      return {
        side,
        art: readable(art),
        label: readable(plaque),
        plaqueOnRight: project(plaque, Vector3.Zero()) > project(art, Vector3.Zero()),
      };
    });
  });
  for (const wall of walls) {
    expect(wall, wall.side).toMatchObject({ art: true, label: true, plaqueOnRight: true });
  }
});
