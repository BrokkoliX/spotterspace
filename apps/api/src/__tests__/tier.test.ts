import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';

import type { Context } from '../context.js';

import {
  cleanDatabase,
  createTestContext,
  prisma,
  setupTestServer,
  teardownTestServer,
} from './testHelpers.js';

// ─── Test helpers ───────────────────────────────────────────────────────────

let server: Awaited<ReturnType<typeof setupTestServer>>;

const ADMIN_USER = { sub: 'sub-admin', email: 'admin@test.com', username: 'admin' };
const SUPERUSER_USER = {
  sub: 'sub-superuser',
  email: 'superuser@test.com',
  username: 'superuser',
};
const REGULAR_USER = { sub: 'sub-regular', email: 'user@test.com', username: 'regular' };

function ctx(user: Context['user'] = null): { contextValue: Context } {
  return { contextValue: createTestContext(user) };
}

async function createBaseUsers() {
  await prisma.user.create({
    data: { email: 'admin@test.com', username: 'admin', cognitoSub: 'sub-admin', role: 'admin' },
  });
  await prisma.user.create({
    data: {
      email: 'superuser@test.com',
      username: 'superuser',
      cognitoSub: 'sub-superuser',
      role: 'superuser',
    },
  });
  return prisma.user.create({
    data: { email: 'user@test.com', username: 'regular', cognitoSub: 'sub-regular', role: 'user' },
  });
}

beforeAll(async () => {
  server = await setupTestServer();
});

afterAll(async () => {
  await teardownTestServer(server);
});

beforeEach(cleanDatabase);

// ─── GraphQL Operations ─────────────────────────────────────────────────────

const TIERS_QUERY = `
  query Tiers {
    tiers {
      id
      slug
      name
      isActive
    }
  }
`;

const ADMIN_TIERS_QUERY = `
  query AdminTiers {
    adminTiers {
      id
      slug
      name
      priceCents
      currency
      uploadsPerDay
      uploadsPerWeek
      canCreateCommunity
      displayOrder
      isActive
    }
  }
`;

const CREATE_TIER = `
  mutation CreateTier($input: CreateTierInput!) {
    createTier(input: $input) {
      id
      slug
      name
      priceCents
      uploadsPerDay
      uploadsPerWeek
      canCreateCommunity
      displayOrder
      isActive
    }
  }
`;

const UPDATE_TIER = `
  mutation UpdateTier($id: ID!, $input: UpdateTierInput!) {
    updateTier(id: $id, input: $input) {
      id
      name
      priceCents
      uploadsPerDay
      canCreateCommunity
      isActive
    }
  }
`;

const DELETE_TIER = `
  mutation DeleteTier($id: ID!) {
    deleteTier(id: $id)
  }
`;

// ─── Tests ──────────────────────────────────────────────────────────────────

describe('tiers (public list)', () => {
  it('returns only active tiers in display order', async () => {
    await prisma.userTier.create({
      data: { slug: 'free', name: 'Free', displayOrder: 0, isActive: true },
    });
    await prisma.userTier.create({
      data: { slug: 'pro', name: 'Pro', displayOrder: 1, isActive: true },
    });
    await prisma.userTier.create({
      data: { slug: 'legacy', name: 'Legacy', displayOrder: 99, isActive: false },
    });

    const res = await server.executeOperation({ query: TIERS_QUERY }, ctx(null));
    const data = (res.body as any).singleResult.data;

    expect(data.tiers).toHaveLength(2);
    expect(data.tiers.map((t: { slug: string }) => t.slug)).toEqual(['free', 'pro']);
  });
});

describe('adminTiers', () => {
  it('returns all tiers (including inactive) for a superuser', async () => {
    await createBaseUsers();
    await prisma.userTier.create({ data: { slug: 'free', name: 'Free', isActive: true } });
    await prisma.userTier.create({ data: { slug: 'legacy', name: 'Legacy', isActive: false } });

    const res = await server.executeOperation({ query: ADMIN_TIERS_QUERY }, ctx(SUPERUSER_USER));
    const data = (res.body as any).singleResult.data;

    expect(data.adminTiers).toHaveLength(2);
  });

  it('rejects admin role', async () => {
    await createBaseUsers();

    const res = await server.executeOperation({ query: ADMIN_TIERS_QUERY }, ctx(ADMIN_USER));
    const errors = (res.body as any).singleResult.errors;
    expect(errors[0].extensions.code).toBe('FORBIDDEN');
  });

  it('rejects unauthenticated callers', async () => {
    const res = await server.executeOperation({ query: ADMIN_TIERS_QUERY }, ctx(null));
    const errors = (res.body as any).singleResult.errors;
    expect(errors[0].extensions.code).toBe('UNAUTHENTICATED');
  });
});

describe('createTier', () => {
  it('creates a tier with defaults when called by a superuser', async () => {
    await createBaseUsers();

    const res = await server.executeOperation(
      {
        query: CREATE_TIER,
        variables: {
          input: {
            slug: 'pro',
            name: 'Pro',
            priceCents: 1999,
            uploadsPerDay: 50,
            uploadsPerWeek: 200,
            canCreateCommunity: true,
            displayOrder: 2,
          },
        },
      },
      ctx(SUPERUSER_USER),
    );

    const data = (res.body as any).singleResult.data;
    expect(data.createTier.slug).toBe('pro');
    expect(data.createTier.priceCents).toBe(1999);
    expect(data.createTier.canCreateCommunity).toBe(true);
    expect(data.createTier.uploadsPerDay).toBe(50);
    expect(data.createTier.isActive).toBe(true); // default
  });

  it('rejects admin role', async () => {
    await createBaseUsers();

    const res = await server.executeOperation(
      { query: CREATE_TIER, variables: { input: { slug: 'pro', name: 'Pro' } } },
      ctx(ADMIN_USER),
    );
    const errors = (res.body as any).singleResult.errors;
    expect(errors[0].extensions.code).toBe('FORBIDDEN');
  });

  it('rejects duplicate slugs', async () => {
    await createBaseUsers();
    await prisma.userTier.create({ data: { slug: 'pro', name: 'Pro' } });

    const res = await server.executeOperation(
      { query: CREATE_TIER, variables: { input: { slug: 'pro', name: 'Pro 2' } } },
      ctx(SUPERUSER_USER),
    );
    const errors = (res.body as any).singleResult.errors;
    expect(errors[0].extensions.code).toBe('BAD_USER_INPUT');
  });

  it('rejects invalid slug format', async () => {
    await createBaseUsers();

    const res = await server.executeOperation(
      { query: CREATE_TIER, variables: { input: { slug: 'INVALID UPPER!', name: 'X' } } },
      ctx(SUPERUSER_USER),
    );
    const errors = (res.body as any).singleResult.errors;
    expect(errors[0].extensions.code).toBe('BAD_USER_INPUT');
  });
});

describe('updateTier', () => {
  it('updates fields when called by a superuser', async () => {
    await createBaseUsers();
    const tier = await prisma.userTier.create({
      data: { slug: 'pro', name: 'Pro', priceCents: 1000, uploadsPerDay: 10 },
    });

    const res = await server.executeOperation(
      {
        query: UPDATE_TIER,
        variables: {
          id: tier.id,
          input: { name: 'Pro+', priceCents: 1500, uploadsPerDay: 20, canCreateCommunity: true },
        },
      },
      ctx(SUPERUSER_USER),
    );

    const data = (res.body as any).singleResult.data;
    expect(data.updateTier.name).toBe('Pro+');
    expect(data.updateTier.priceCents).toBe(1500);
    expect(data.updateTier.uploadsPerDay).toBe(20);
    expect(data.updateTier.canCreateCommunity).toBe(true);
  });

  it('returns NOT_FOUND for unknown id', async () => {
    await createBaseUsers();

    const res = await server.executeOperation(
      {
        query: UPDATE_TIER,
        variables: {
          id: '00000000-0000-0000-0000-000000000000',
          input: { name: 'Renamed' },
        },
      },
      ctx(SUPERUSER_USER),
    );
    const errors = (res.body as any).singleResult.errors;
    expect(errors[0].extensions.code).toBe('NOT_FOUND');
  });

  it('rejects admin role', async () => {
    await createBaseUsers();
    const tier = await prisma.userTier.create({ data: { slug: 'pro', name: 'Pro' } });

    const res = await server.executeOperation(
      { query: UPDATE_TIER, variables: { id: tier.id, input: { name: 'Pro+' } } },
      ctx(ADMIN_USER),
    );
    const errors = (res.body as any).singleResult.errors;
    expect(errors[0].extensions.code).toBe('FORBIDDEN');
  });
});

describe('deleteTier', () => {
  it('deletes an unused tier when called by a superuser', async () => {
    await createBaseUsers();
    const tier = await prisma.userTier.create({ data: { slug: 'legacy', name: 'Legacy' } });

    const res = await server.executeOperation(
      { query: DELETE_TIER, variables: { id: tier.id } },
      ctx(SUPERUSER_USER),
    );

    const data = (res.body as any).singleResult.data;
    expect(data.deleteTier).toBe(true);
    const remaining = await prisma.userTier.findUnique({ where: { id: tier.id } });
    expect(remaining).toBeNull();
  });

  it("refuses to delete the 'free' tier", async () => {
    await createBaseUsers();
    const tier = await prisma.userTier.create({ data: { slug: 'free', name: 'Free' } });

    const res = await server.executeOperation(
      { query: DELETE_TIER, variables: { id: tier.id } },
      ctx(SUPERUSER_USER),
    );
    const errors = (res.body as any).singleResult.errors;
    expect(errors[0].extensions.code).toBe('FORBIDDEN');
  });

  it('refuses to delete a tier with users still assigned', async () => {
    const regular = await createBaseUsers();
    const tier = await prisma.userTier.create({ data: { slug: 'pro', name: 'Pro' } });
    await prisma.user.update({ where: { id: regular.id }, data: { tierId: tier.id } });

    const res = await server.executeOperation(
      { query: DELETE_TIER, variables: { id: tier.id } },
      ctx(SUPERUSER_USER),
    );
    const errors = (res.body as any).singleResult.errors;
    expect(errors[0].extensions.code).toBe('FAILED_PRECONDITION');
  });

  it('rejects admin role', async () => {
    await createBaseUsers();
    const tier = await prisma.userTier.create({ data: { slug: 'pro', name: 'Pro' } });

    const res = await server.executeOperation(
      { query: DELETE_TIER, variables: { id: tier.id } },
      ctx(ADMIN_USER),
    );
    const errors = (res.body as any).singleResult.errors;
    expect(errors[0].extensions.code).toBe('FORBIDDEN');
  });

  it('rejects unauthenticated', async () => {
    await createBaseUsers();
    const tier = await prisma.userTier.create({ data: { slug: 'pro', name: 'Pro' } });

    const res = await server.executeOperation(
      { query: DELETE_TIER, variables: { id: tier.id } },
      ctx(null),
    );
    const errors = (res.body as any).singleResult.errors;
    expect(errors[0].extensions.code).toBe('UNAUTHENTICATED');
  });
});

// Silence unused-import lint for REGULAR_USER — left in place for symmetry
// with admin.test.ts in case future tier tests need it.
void REGULAR_USER;
