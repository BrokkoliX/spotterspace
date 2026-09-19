import { ApolloServer } from '@apollo/server';
import { Prisma, prisma } from '@spotterspace/db';

import type { Context } from '../context.js';
import { createLoaders } from '../loaders.js';
import { resolvers } from '../resolvers.js';
import { typeDefs } from '../schema.js';

// ─── Server lifecycle ─────────────────────────────────────────────────────────

export async function setupTestServer(): Promise<ApolloServer<Context>> {
  const server = new ApolloServer<Context>({ typeDefs, resolvers });
  await server.start();
  return server;
}

export async function teardownTestServer(server: ApolloServer<Context>): Promise<void> {
  await server.stop();
  await prisma.$disconnect();
}

// ─── Context helpers ──────────────────────────────────────────────────────────

// Minimal mock for ServerResponse with setHeader
const mockRes = {
  setHeader: (_name: string, _value: string | string[]) => {
    // no-op in tests
  },
  getHeader: () => undefined,
  removeHeader: () => {},
  statusCode: 200,
  statusMessage: '',
  end: () => {},
  write: () => false,
  once: () => {},
  addListener: () => {},
  emit: () => false,
  on: () => {},
  appendHeader: () => mockRes as unknown as import('node:http').ServerResponse,
  flushHeaders: () => mockRes as unknown as import('node:http').ServerResponse,
} as unknown as import('node:http').ServerResponse;

export function createTestContext(user: Context['user'] = null): Context {
  return { prisma, user, loaders: createLoaders(prisma), res: mockRes, req: {} as Context['req'] };
}

export async function createTestUser(
  overrides: Partial<{
    email: string;
    username: string;
    cognitoSub: string;
    role: 'user' | 'moderator' | 'admin' | 'superuser';
  }> = {},
) {
  const user = await prisma.user.create({
    data: {
      email: overrides.email ?? 'test@example.com',
      username: overrides.username ?? 'testuser',
      cognitoSub: overrides.cognitoSub ?? 'test-sub-1',
      ...(overrides.role !== undefined && { role: overrides.role }),
    },
  });
  const ctx = createTestContext({
    sub: user.cognitoSub,
    email: user.email,
    username: user.username,
  });
  return { user, ctx };
}

// ─── Database cleanup ─────────────────────────────────────────────────────────

/**
 * Cached list of fully-qualified table names (schema.tableName) derived from
 * the Prisma DMMF datamodel. Computed once on first call and reused.
 */
let cachedTableList: string | null = null;

/**
 * Build a comma-separated list of quoted table identifiers from the Prisma
 * DMMF. Falls back to the model name when no `@@map` is set, which mirrors
 * Prisma's own table-naming convention.
 */
function getTableList(): string {
  if (cachedTableList) return cachedTableList;
  const tables = Prisma.dmmf.datamodel.models
    .map((model) => model.dbName ?? model.name)
    .map((name) => `"public"."${name}"`);
  cachedTableList = tables.join(', ');
  return cachedTableList;
}

/**
 * Truncates every table managed by Prisma in a single statement. Uses
 * `TRUNCATE ... RESTART IDENTITY CASCADE` so FK ordering is handled by
 * Postgres rather than hand-maintained, and sequence values reset between
 * tests for deterministic IDs where applicable.
 *
 * Replaces the previous hand-maintained delete-list which was fragile to
 * schema drift — any new model in `schema.prisma` would silently leak rows
 * across test cases until somebody remembered to add a `deleteMany` call.
 */
export async function cleanDatabase(): Promise<void> {
  const tables = getTableList();
  if (!tables) return;
  await waitForBackgroundWrites();
  for (let attempt = 1; ; attempt++) {
    try {
      await prisma.$executeRawUnsafe(`TRUNCATE TABLE ${tables} RESTART IDENTITY CASCADE;`);
      return;
    } catch (err) {
      if (!isDeadlock(err) || attempt >= MAX_TRUNCATE_ATTEMPTS) throw err;
      await sleep(50 * attempt);
    }
  }
}

// ─── Background-write settling ────────────────────────────────────────────────
// Several mutations deliberately fire writes without awaiting them — most
// notably createNotification(). Such a write can still be in flight when the
// next test's cleanDatabase() runs, and TRUNCATE's AccessExclusiveLock then
// deadlocks with the insert's RowShareLock (Postgres 40P01). That surfaced as
// intermittent failures in whichever test happened to run next
// (community.test.ts most often). So before truncating, wait for every other
// session on the test database to go idle, and retry the TRUNCATE if a
// deadlock still slips through.

const MAX_TRUNCATE_ATTEMPTS = 5;
const SETTLE_TIMEOUT_MS = 2_000;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isDeadlock(err: unknown): boolean {
  return err instanceof Error && /\b40P01\b|deadlock detected/.test(err.message);
}

async function waitForBackgroundWrites(): Promise<void> {
  // Yield once so fire-and-forget promises queued by the last test get to
  // issue their query before we look for it.
  await new Promise((resolve) => setImmediate(resolve));
  const deadline = Date.now() + SETTLE_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const [{ busy }] = await prisma.$queryRaw<{ busy: bigint }[]>`
      SELECT count(*) AS busy
      FROM pg_stat_activity
      WHERE datname = current_database()
        AND pid <> pg_backend_pid()
        AND backend_type = 'client backend'
        AND state <> 'idle'`;
    if (busy === 0n) return;
    await sleep(20);
  }
}

export { prisma };
