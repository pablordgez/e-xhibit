import { test, expect } from '@playwright/test';
import { createServer } from 'node:http';
import { sample } from '../../src/core/sample';

test('production assets enforce anti-framing, MIME and referrer policies', async ({ page }) => {
  const response = await page.goto('/admin');
  await expect(page.getByRole('heading', { name: 'Sign in', exact: true })).toBeVisible();
  const headers = response!.headers();
  expect(headers['content-security-policy']).toContain("frame-ancestors 'none'");
  expect(headers['x-frame-options']).toBe('DENY');
  expect(headers['x-content-type-options']).toBe('nosniff');
  expect(headers['referrer-policy']).toBe('strict-origin-when-cross-origin');
  expect((await page.request.get('/api/draft')).status()).toBe(401);
  const host = createServer((_, response) => {
    response.setHeader('Content-Type', 'text/html');
    response.end('<iframe src="http://127.0.0.1:8787/admin"></iframe>');
  });
  await new Promise<void>((resolve) => host.listen(0, '127.0.0.1', resolve));
  try {
    const errors: string[] = [];
    page.on('console', (message) => errors.push(message.text()));
    await page.goto(`http://127.0.0.1:${(host.address() as { port: number }).port}`);
    await expect
      .poll(() => errors.some((message) => /frame-ancestors|X-Frame-Options/.test(message)))
      .toBe(true);
    await expect(
      page.frameLocator('iframe').getByRole('heading', { name: 'Sign in', exact: true }),
    ).toHaveCount(0);
  } finally {
    await new Promise<void>((resolve) => host.close(() => resolve()));
  }
});

test('the production CSP supports the existing 3D exhibit and accessible collection', async ({
  page,
}) => {
  const errors: string[] = [],
    violations: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('console', (message) => {
    if (/Content Security Policy|violates.*directive/.test(message.text()))
      violations.push(message.text());
  });
  await page.route('**/api/current', (route) =>
    route.fulfill({ json: { id: 'fixture', document: sample } }),
  );
  await page.goto('/visit');
  await page.getByRole('button', { name: 'Enter exhibition', exact: true }).click();
  await expect(page.locator('canvas.museum-canvas')).toBeVisible();
  await page.getByRole('button', { name: 'Collection', exact: true }).click();
  await page
    .getByRole('dialog')
    .getByRole('button', { name: /After the rain/ })
    .click();
  await expect(page.getByRole('dialog').getByText(/A landscape reduced/)).toBeVisible();
  expect(errors).toEqual([]);
  expect(violations).toEqual([]);
});
