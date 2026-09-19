import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';

import type { Context } from '../context.js';

import {
  cleanDatabase,
  createTestContext,
  prisma,
  setupTestServer,
  teardownTestServer,
} from './testHelpers.js';

// ─── Test scaffolding ───────────────────────────────────────────────────────

let server: Awaited<ReturnType<typeof setupTestServer>>;

const SUPERUSER = { sub: 'sub-super', email: 'super@test.com', username: 'super' };
const REGULAR_USER = { sub: 'sub-regular', email: 'user@test.com', username: 'regular' };

function ctx(user: Context['user'] = null): { contextValue: Context } {
  return { contextValue: createTestContext(user) };
}

beforeAll(async () => {
  server = await setupTestServer();
});

afterAll(async () => {
  await teardownTestServer(server);
});

beforeEach(cleanDatabase);

// ─── GraphQL operations ─────────────────────────────────────────────────────

const SITE_SETTINGS = `
  query SiteSettings {
    siteSettings {
      id
      mapRefreshDebounceMs
    }
  }
`;

const UPDATE_SITE_SETTINGS = `
  mutation UpdateSiteSettings($input: UpdateSiteSettingsInput!) {
    updateSiteSettings(input: $input) {
      id
      mapRefreshDebounceMs
    }
  }
`;

// ─── Helpers ────────────────────────────────────────────────────────────────

async function createSuperuser() {
  return prisma.user.create({
    data: {
      email: SUPERUSER.email,
      username: SUPERUSER.username,
      cognitoSub: SUPERUSER.sub,
      role: 'superuser',
    },
  });
}

async function createRegular() {
  return prisma.user.create({
    data: {
      email: REGULAR_USER.email,
      username: REGULAR_USER.username,
      cognitoSub: REGULAR_USER.sub,
      role: 'user',
    },
  });
}

// ─── Tests ──────────────────────────────────────────────────────────────────

describe('siteSettings.mapRefreshDebounceMs', () => {
  it('defaults to 300 ms when the SiteSettings row is auto-created', async () => {
    const res = await server.executeOperation({ query: SITE_SETTINGS }, ctx(null));

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const data = (res.body as any).singleResult.data;
    expect(data.siteSettings.mapRefreshDebounceMs).toBe(300);
  });

  it('returns the persisted value once a superuser updates it', async () => {
    await createSuperuser();

    const update = await server.executeOperation(
      { query: UPDATE_SITE_SETTINGS, variables: { input: { mapRefreshDebounceMs: 1500 } } },
      ctx(SUPERUSER),
    );
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const updateData = (update.body as any).singleResult.data;
    expect(updateData.updateSiteSettings.mapRefreshDebounceMs).toBe(1500);

    const read = await server.executeOperation({ query: SITE_SETTINGS }, ctx(null));
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const readData = (read.body as any).singleResult.data;
    expect(readData.siteSettings.mapRefreshDebounceMs).toBe(1500);
  });

  it('accepts 0 ms (debouncing disabled)', async () => {
    await createSuperuser();

    const res = await server.executeOperation(
      { query: UPDATE_SITE_SETTINGS, variables: { input: { mapRefreshDebounceMs: 0 } } },
      ctx(SUPERUSER),
    );
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const data = (res.body as any).singleResult.data;
    expect(data.updateSiteSettings.mapRefreshDebounceMs).toBe(0);
  });

  it('rejects values below 0 with BAD_USER_INPUT', async () => {
    await createSuperuser();

    const res = await server.executeOperation(
      { query: UPDATE_SITE_SETTINGS, variables: { input: { mapRefreshDebounceMs: -1 } } },
      ctx(SUPERUSER),
    );
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const errors = (res.body as any).singleResult.errors;
    expect(errors[0].extensions.code).toBe('BAD_USER_INPUT');
  });

  it('rejects values above 10000 with BAD_USER_INPUT', async () => {
    await createSuperuser();

    const res = await server.executeOperation(
      { query: UPDATE_SITE_SETTINGS, variables: { input: { mapRefreshDebounceMs: 10001 } } },
      ctx(SUPERUSER),
    );
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const errors = (res.body as any).singleResult.errors;
    expect(errors[0].extensions.code).toBe('BAD_USER_INPUT');
  });

  it('forbids non-superusers from updating the setting', async () => {
    await createRegular();

    const res = await server.executeOperation(
      { query: UPDATE_SITE_SETTINGS, variables: { input: { mapRefreshDebounceMs: 500 } } },
      ctx(REGULAR_USER),
    );
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const errors = (res.body as any).singleResult.errors;
    expect(errors[0].extensions.code).toBe('FORBIDDEN');
  });
});
