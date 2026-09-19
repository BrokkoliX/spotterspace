import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import {
  cleanDatabase,
  createTestContext,
  prisma,
  setupTestServer,
  teardownTestServer,
} from './testHelpers.js';

let server: Awaited<ReturnType<typeof setupTestServer>>;

beforeAll(async () => {
  server = await setupTestServer();
});

afterAll(async () => {
  await teardownTestServer(server);
});

beforeEach(cleanDatabase);

const REQUEST_PASSWORD_RESET = `
  mutation RequestPasswordReset($email: String!) {
    requestPasswordReset(email: $email)
  }
`;

/**
 * Run a function several times and return the median elapsed milliseconds.
 * Median is more stable than mean against GC pauses or scheduler jitter.
 */
async function medianTiming(fn: () => Promise<unknown>, iterations: number): Promise<number> {
  const samples: number[] = [];
  for (let i = 0; i < iterations; i += 1) {
    const start = performance.now();
    await fn();
    samples.push(performance.now() - start);
  }
  samples.sort((a, b) => a - b);
  return samples[Math.floor(samples.length / 2)];
}

// ─── Timing-oracle regression test ──────────────────────────────────────────
//
// Sprint 2 (S2.5) added a constant-time fake bcrypt hash on the
// requestPasswordReset miss path so an attacker cannot use response latency
// to enumerate registered email addresses. Without the fake hash, the hit
// path performs ~70-200ms of token + email work while the miss path returns
// in <5ms — a trivial oracle.
//
// We assert the miss-path median latency is at least within an order of
// magnitude of the hit-path median. The exact ratio depends on hardware, so
// we use a generous tolerance (miss must be >= hit / 4) to keep the test
// stable on slow CI runners while still catching a regression that drops
// the fake hash entirely.
describe('Auth: requestPasswordReset timing oracle', () => {
  it('miss-path latency is comparable to hit-path latency', async () => {
    // Seed one real user for the hit path
    await prisma.user.create({
      data: {
        email: 'real-user@example.com',
        username: 'realuser',
        cognitoSub: 'real-sub',
        passwordHash: 'bcrypt-hash-placeholder',
      },
    });

    const ctx = createTestContext(null);

    // Warm-up: prime the bcrypt module and connection pool so the first
    // sample isn't artificially slow.
    await server.executeOperation(
      { query: REQUEST_PASSWORD_RESET, variables: { email: 'real-user@example.com' } },
      { contextValue: ctx },
    );
    await server.executeOperation(
      { query: REQUEST_PASSWORD_RESET, variables: { email: 'nobody@example.com' } },
      { contextValue: ctx },
    );

    const ITERATIONS = 5;
    const hitMedian = await medianTiming(
      () =>
        server.executeOperation(
          { query: REQUEST_PASSWORD_RESET, variables: { email: 'real-user@example.com' } },
          { contextValue: ctx },
        ),
      ITERATIONS,
    );
    const missMedian = await medianTiming(
      () =>
        server.executeOperation(
          { query: REQUEST_PASSWORD_RESET, variables: { email: 'nobody@example.com' } },
          { contextValue: ctx },
        ),
      ITERATIONS,
    );

    // Diagnostic logging in case the assertion fails on CI

    console.log(`[timing] hit=${hitMedian.toFixed(1)}ms  miss=${missMedian.toFixed(1)}ms`);

    // The miss path must take at least a quarter of the hit path. Without
    // the fake bcrypt this ratio collapses to ~1/50.
    expect(missMedian).toBeGreaterThanOrEqual(hitMedian / 4);
  });
});
