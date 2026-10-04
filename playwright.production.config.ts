import { defineConfig, devices } from '@playwright/test';
export default defineConfig({
  testDir: './tests/production',
  workers: 1,
  timeout: 45_000,
  use: {
    baseURL: 'http://127.0.0.1:8787',
    ...devices['Desktop Chrome'],
    launchOptions: {
      args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'],
    },
  },
  webServer: {
    command: 'npm run build && npx wrangler dev --ip 127.0.0.1 --port 8787',
    url: 'http://127.0.0.1:8787',
    reuseExistingServer: false,
    timeout: 120_000,
  },
});
