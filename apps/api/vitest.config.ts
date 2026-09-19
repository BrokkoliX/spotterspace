import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    // vitest 5 removed '**/dist/**' from defaultExclude (it is now only
    // node_modules and .git). `npm run build` compiles src/__tests__ into
    // dist/__tests__, so without this every test file is collected twice —
    // once as TS source and once as stale compiled JS.
    exclude: ['**/node_modules/**', '**/.git/**', '**/dist/**'],
    testTimeout: 30_000,
    hookTimeout: 30_000,
    // Run test files sequentially — they share a database and clean tables in beforeEach
    fileParallelism: false,
    // Initialise the test database (separate from dev) before any tests run
    globalSetup: './vitest.setup.ts',
    // Override DATABASE_URL in the test worker process BEFORE any module imports PrismaClient
    setupFiles: ['./vitest.env.ts'],
  },
});
