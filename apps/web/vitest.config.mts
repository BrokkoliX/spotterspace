import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  test: {
    globals: true,
    environment: 'jsdom',
    // vitest 5 no longer excludes dist/ by default (see apps/api/vitest.config.ts)
    exclude: ['**/node_modules/**', '**/.git/**', '**/dist/**', '**/.next/**'],
    setupFiles: ['./vitest.setup.ts'],
    passWithNoTests: true,
  },
  resolve: {
    alias: {
      '@': new URL('./src', import.meta.url).pathname,
    },
  },
});
