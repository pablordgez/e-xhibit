import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
export default defineConfig({
  plugins: [react()],
  build: { chunkSizeWarningLimit: 1200 },
  server: { proxy: { '/api': 'http://localhost:8787' } },
  test: { include: ['tests/**/*.test.ts'] },
} as Parameters<typeof defineConfig>[0]);
