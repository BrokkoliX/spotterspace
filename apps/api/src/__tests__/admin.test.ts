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
const MOD_USER = { sub: 'sub-mod', email: 'mod@test.com', username: 'moderator' };
const REGULAR_USER = { sub: 'sub-regular', email: 'user@test.com', username: 'regular' };
const SUPERUSER_USER = {
  sub: 'sub-superuser',
  email: 'superuser@test.com',
  username: 'superuser',
};

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

// ─── GraphQL Operations ─────────────────────────────────────────────────────

const ADMIN_STATS = `
  query AdminStats {
    adminStats {
      totalUsers
      totalPhotos
      pendingPhotos
      openReports
      totalAirports
      totalSpottingLocations
    }
  }
`;

const ADMIN_REPORTS = `
  query AdminReports($status: String, $first: Int) {
    adminReports(status: $status, first: $first) {
      edges {
        node {
          id
          targetType
          targetId
          reason
          status
          reporter { id username }
          reviewer { id username }
          resolvedAt
        }
      }
      totalCount
      pageInfo { hasNextPage endCursor }
    }
  }
`;

const ADMIN_USERS = `
  query AdminUsers($role: String, $status: String, $search: String, $first: Int) {
    adminUsers(role: $role, status: $status, search: $search, first: $first) {
      edges {
        node { id username email role status }
      }
      totalCount
    }
  }
`;

const ADMIN_PHOTOS = `
  query AdminPhotos($moderationStatus: String, $first: Int) {
    adminPhotos(moderationStatus: $moderationStatus, first: $first) {
      edges {
        node { id moderationStatus user { username } }
      }
      totalCount
    }
  }
`;

const RESOLVE_REPORT = `
  mutation AdminResolveReport($id: ID!, $action: String!) {
    adminResolveReport(id: $id, action: $action) {
      id
      status
      reviewer { username }
      resolvedAt
    }
  }
`;

const UPDATE_USER_STATUS = `
  mutation AdminUpdateUserStatus($userId: ID!, $status: String!) {
    adminUpdateUserStatus(userId: $userId, status: $status) {
      id
      status
    }
  }
`;

const UPDATE_USER_ROLE = `
  mutation AdminUpdateUserRole($userId: ID!, $role: String!) {
    adminUpdateUserRole(userId: $userId, role: $role) {
      id
      role
    }
  }
`;

const UPDATE_PHOTO_MODERATION = `
  mutation AdminUpdatePhotoModeration($photoId: ID!, $status: String!) {
    adminUpdatePhotoModeration(photoId: $photoId, status: $status) {
      id
      moderationStatus
    }
  }
`;

const CREATE_AIRLINE = `
  mutation CreateAirline($input: CreateAirlineInput!) {
    createAirline(input: $input) {
      id
      name
      icaoCode
      iataCode
    }
  }
`;

const UPSERT_AIRLINE = `
  mutation UpsertAirline($input: CreateAirlineInput!) {
    upsertAirline(input: $input) {
      id
      name
      icaoCode
      iataCode
    }
  }
`;

const AIRLINE_BY_ICAO = `
  query AirlineByIcao($icaoCode: String!) {
    airline(icaoCode: $icaoCode) {
      id
      name
      icaoCode
    }
  }
`;

// ─── Helpers ────────────────────────────────────────────────────────────────

async function createUsers() {
  const admin = await prisma.user.create({
    data: { email: 'admin@test.com', username: 'admin', cognitoSub: 'sub-admin', role: 'admin' },
  });
  const mod = await prisma.user.create({
    data: {
      email: 'mod@test.com',
      username: 'moderator',
      cognitoSub: 'sub-mod',
      role: 'moderator',
    },
  });
  const regular = await prisma.user.create({
    data: { email: 'user@test.com', username: 'regular', cognitoSub: 'sub-regular', role: 'user' },
  });
  const superuser = await prisma.user.create({
    data: {
      email: 'superuser@test.com',
      username: 'superuser',
      cognitoSub: 'sub-superuser',
      role: 'superuser',
    },
  });
  return { admin, mod, regular, superuser };
}

// ─── Tests ──────────────────────────────────────────────────────────────────

describe('adminStats', () => {
  it('returns platform statistics for admin', async () => {
    const { regular } = await createUsers();
    // `totalPhotos` counts only approved, non-deleted photos while
    // `pendingPhotos` counts pending ones, so seed one of each — a single
    // pending photo would leave totalPhotos asserting against zero.
    await prisma.photo.create({
      data: {
        userId: regular.id,
        originalUrl: 'http://localhost:4566/approved.jpg',
        mimeType: 'image/jpeg',
        moderationStatus: 'approved',
      },
    });
    await prisma.photo.create({
      data: {
        userId: regular.id,
        originalUrl: 'http://localhost:4566/pending.jpg',
        mimeType: 'image/jpeg',
        moderationStatus: 'pending',
      },
    });

    const res = await server.executeOperation({ query: ADMIN_STATS }, ctx(ADMIN_USER));

    const data = (res.body as any).singleResult.data;
    expect(data.adminStats.totalUsers).toBe(4);
    expect(data.adminStats.totalPhotos).toBe(1);
    expect(data.adminStats.pendingPhotos).toBe(1);
  });

  it('works for moderator role', async () => {
    await createUsers();

    const res = await server.executeOperation({ query: ADMIN_STATS }, ctx(MOD_USER));

    const data = (res.body as any).singleResult.data;
    expect(data.adminStats.totalUsers).toBe(4);
  });

  it('rejects regular user', async () => {
    await createUsers();

    const res = await server.executeOperation({ query: ADMIN_STATS }, ctx(REGULAR_USER));

    const errors = (res.body as any).singleResult.errors;
    expect(errors[0].extensions.code).toBe('FORBIDDEN');
  });

  it('rejects unauthenticated user', async () => {
    const res = await server.executeOperation({ query: ADMIN_STATS }, ctx(null));

    const errors = (res.body as any).singleResult.errors;
    expect(errors[0].extensions.code).toBe('UNAUTHENTICATED');
  });
});

describe('adminReports', () => {
  it('returns paginated reports', async () => {
    const { regular } = await createUsers();
    const photo = await prisma.photo.create({
      data: {
        userId: regular.id,
        originalUrl: 'http://localhost:4566/test.jpg',
        mimeType: 'image/jpeg',
        moderationStatus: 'approved',
      },
    });
    await prisma.report.create({
      data: {
        reporterId: regular.id,
        targetType: 'photo',
        targetId: photo.id,
        reason: 'spam',
      },
    });

    const res = await server.executeOperation(
      { query: ADMIN_REPORTS, variables: { status: 'open' } },
      ctx(ADMIN_USER),
    );

    const data = (res.body as any).singleResult.data;
    expect(data.adminReports.totalCount).toBe(1);
    expect(data.adminReports.edges[0].node.reason).toBe('spam');
    expect(data.adminReports.edges[0].node.reporter.username).toBe('regular');
  });

  it('filters by status', async () => {
    const { regular } = await createUsers();
    const photo = await prisma.photo.create({
      data: {
        userId: regular.id,
        originalUrl: 'http://localhost:4566/test.jpg',
        mimeType: 'image/jpeg',
      },
    });
    await prisma.report.create({
      data: {
        reporterId: regular.id,
        targetType: 'photo',
        targetId: photo.id,
        reason: 'spam',
        status: 'resolved',
      },
    });

    const res = await server.executeOperation(
      { query: ADMIN_REPORTS, variables: { status: 'open' } },
      ctx(ADMIN_USER),
    );

    const data = (res.body as any).singleResult.data;
    expect(data.adminReports.totalCount).toBe(0);
  });
});

describe('adminResolveReport', () => {
  it('resolves a report', async () => {
    const { regular } = await createUsers();
    const photo = await prisma.photo.create({
      data: {
        userId: regular.id,
        originalUrl: 'http://localhost:4566/test.jpg',
        mimeType: 'image/jpeg',
      },
    });
    const report = await prisma.report.create({
      data: {
        reporterId: regular.id,
        targetType: 'photo',
        targetId: photo.id,
        reason: 'spam',
      },
    });

    const res = await server.executeOperation(
      { query: RESOLVE_REPORT, variables: { id: report.id, action: 'resolved' } },
      ctx(ADMIN_USER),
    );

    const data = (res.body as any).singleResult.data;
    expect(data.adminResolveReport.status).toBe('resolved');
    expect(data.adminResolveReport.reviewer.username).toBe('admin');
    expect(data.adminResolveReport.resolvedAt).toBeTruthy();
  });

  it('dismisses a report', async () => {
    const { regular } = await createUsers();
    const photo = await prisma.photo.create({
      data: {
        userId: regular.id,
        originalUrl: 'http://localhost:4566/test.jpg',
        mimeType: 'image/jpeg',
      },
    });
    const report = await prisma.report.create({
      data: {
        reporterId: regular.id,
        targetType: 'photo',
        targetId: photo.id,
        reason: 'inappropriate',
      },
    });

    const res = await server.executeOperation(
      { query: RESOLVE_REPORT, variables: { id: report.id, action: 'dismissed' } },
      ctx(MOD_USER),
    );

    const data = (res.body as any).singleResult.data;
    expect(data.adminResolveReport.status).toBe('dismissed');
  });

  it('rejects invalid action', async () => {
    const { regular } = await createUsers();
    const photo = await prisma.photo.create({
      data: {
        userId: regular.id,
        originalUrl: 'http://localhost:4566/test.jpg',
        mimeType: 'image/jpeg',
      },
    });
    const report = await prisma.report.create({
      data: {
        reporterId: regular.id,
        targetType: 'photo',
        targetId: photo.id,
        reason: 'spam',
      },
    });

    const res = await server.executeOperation(
      { query: RESOLVE_REPORT, variables: { id: report.id, action: 'invalid' } },
      ctx(ADMIN_USER),
    );

    const errors = (res.body as any).singleResult.errors;
    expect(errors[0].extensions.code).toBe('BAD_USER_INPUT');
  });
});

describe('adminUpdateUserStatus', () => {
  it('suspends a user when called by a superuser', async () => {
    const { regular } = await createUsers();

    const res = await server.executeOperation(
      { query: UPDATE_USER_STATUS, variables: { userId: regular.id, status: 'suspended' } },
      ctx(SUPERUSER_USER),
    );

    const data = (res.body as any).singleResult.data;
    expect(data.adminUpdateUserStatus.status).toBe('suspended');
  });

  it('rejects admin role', async () => {
    const { regular } = await createUsers();

    const res = await server.executeOperation(
      { query: UPDATE_USER_STATUS, variables: { userId: regular.id, status: 'suspended' } },
      ctx(ADMIN_USER),
    );

    const errors = (res.body as any).singleResult.errors;
    expect(errors[0].extensions.code).toBe('FORBIDDEN');
  });

  it('rejects moderator role', async () => {
    const { regular } = await createUsers();

    const res = await server.executeOperation(
      { query: UPDATE_USER_STATUS, variables: { userId: regular.id, status: 'suspended' } },
      ctx(MOD_USER),
    );

    const errors = (res.body as any).singleResult.errors;
    expect(errors[0].extensions.code).toBe('FORBIDDEN');
  });
});

describe('adminUpdateUserRole', () => {
  it('promotes a user to moderator when called by a superuser', async () => {
    const { regular } = await createUsers();

    const res = await server.executeOperation(
      { query: UPDATE_USER_ROLE, variables: { userId: regular.id, role: 'moderator' } },
      ctx(SUPERUSER_USER),
    );

    const data = (res.body as any).singleResult.data;
    expect(data.adminUpdateUserRole.role).toBe('moderator');
  });

  it('rejects admin role', async () => {
    const { regular } = await createUsers();

    const res = await server.executeOperation(
      { query: UPDATE_USER_ROLE, variables: { userId: regular.id, role: 'admin' } },
      ctx(ADMIN_USER),
    );

    const errors = (res.body as any).singleResult.errors;
    expect(errors[0].extensions.code).toBe('FORBIDDEN');
  });

  it('rejects moderator role', async () => {
    const { regular } = await createUsers();

    const res = await server.executeOperation(
      { query: UPDATE_USER_ROLE, variables: { userId: regular.id, role: 'admin' } },
      ctx(MOD_USER),
    );

    const errors = (res.body as any).singleResult.errors;
    expect(errors[0].extensions.code).toBe('FORBIDDEN');
  });
});

describe('adminUpdatePhotoModeration', () => {
  it('approves a photo', async () => {
    const { regular } = await createUsers();
    const photo = await prisma.photo.create({
      data: {
        userId: regular.id,
        originalUrl: 'http://localhost:4566/test.jpg',
        mimeType: 'image/jpeg',
        moderationStatus: 'pending',
      },
    });

    const res = await server.executeOperation(
      { query: UPDATE_PHOTO_MODERATION, variables: { photoId: photo.id, status: 'approved' } },
      ctx(ADMIN_USER),
    );

    const data = (res.body as any).singleResult.data;
    expect(data.adminUpdatePhotoModeration.moderationStatus).toBe('approved');
  });

  it('rejects a photo', async () => {
    const { regular } = await createUsers();
    const photo = await prisma.photo.create({
      data: {
        userId: regular.id,
        originalUrl: 'http://localhost:4566/test.jpg',
        mimeType: 'image/jpeg',
        moderationStatus: 'pending',
      },
    });

    const res = await server.executeOperation(
      { query: UPDATE_PHOTO_MODERATION, variables: { photoId: photo.id, status: 'rejected' } },
      ctx(MOD_USER),
    );

    const data = (res.body as any).singleResult.data;
    expect(data.adminUpdatePhotoModeration.moderationStatus).toBe('rejected');

    // The photo owner should receive an in-app notification of type 'moderation'
    const notifications = await prisma.notification.findMany({
      where: { userId: regular.id, type: 'moderation' },
    });
    expect(notifications.length).toBe(1);
    expect(notifications[0].title).toContain('rejected');
    expect((notifications[0].data as any)?.photoId).toBe(photo.id);
  });

  it('rejects invalid status', async () => {
    const { regular } = await createUsers();
    const photo = await prisma.photo.create({
      data: {
        userId: regular.id,
        originalUrl: 'http://localhost:4566/test.jpg',
        mimeType: 'image/jpeg',
      },
    });

    const res = await server.executeOperation(
      { query: UPDATE_PHOTO_MODERATION, variables: { photoId: photo.id, status: 'nope' } },
      ctx(ADMIN_USER),
    );

    const errors = (res.body as any).singleResult.errors;
    expect(errors[0].extensions.code).toBe('BAD_USER_INPUT');
  });
});

describe('adminUsers', () => {
  it('lists users with role filter when called by a superuser', async () => {
    await createUsers();

    const res = await server.executeOperation(
      { query: ADMIN_USERS, variables: { role: 'admin' } },
      ctx(SUPERUSER_USER),
    );

    const data = (res.body as any).singleResult.data;
    expect(data.adminUsers.totalCount).toBe(1);
    expect(data.adminUsers.edges[0].node.username).toBe('admin');
  });

  it('searches by username when called by a superuser', async () => {
    await createUsers();

    const res = await server.executeOperation(
      { query: ADMIN_USERS, variables: { search: 'mod' } },
      ctx(SUPERUSER_USER),
    );

    const data = (res.body as any).singleResult.data;
    expect(data.adminUsers.totalCount).toBe(1);
    expect(data.adminUsers.edges[0].node.username).toBe('moderator');
  });

  it('exposes email in admin queries (staff visibility)', async () => {
    await createUsers();

    const res = await server.executeOperation(
      { query: ADMIN_USERS, variables: { search: 'regular' } },
      ctx(SUPERUSER_USER),
    );

    const data = (res.body as any).singleResult.data;
    expect(data.adminUsers.edges[0].node.email).toBe('user@test.com');
  });

  it('allows admin role', async () => {
    await createUsers();

    const res = await server.executeOperation(
      { query: ADMIN_USERS, variables: {} },
      ctx(ADMIN_USER),
    );

    expect((res.body as any).singleResult.errors).toBeUndefined();
    expect((res.body as any).singleResult.data.adminUsers.edges.length).toBeGreaterThan(0);
  });

  it('rejects moderator role', async () => {
    await createUsers();

    const res = await server.executeOperation({ query: ADMIN_USERS, variables: {} }, ctx(MOD_USER));

    const errors = (res.body as any).singleResult.errors;
    expect(errors[0].extensions.code).toBe('FORBIDDEN');
  });
});

const ADMIN_USER_BY_ID = `
  query AdminUserById($id: ID!) {
    adminUserById(id: $id) {
      id
      username
      email
      role
      status
      cognitoSub
      failedAttempts
      lastLoginAt
      tier { id slug name }
    }
  }
`;

describe('adminUserById', () => {
  it('returns full user detail for a superuser caller', async () => {
    const { regular } = await createUsers();
    // The migration seeds a 'free' tier in dev/prod, but cleanDatabase
    // truncates it before each test, so re-seed here. The User.tier
    // resolver falls back to the tier with slug 'free' when User.tierId
    // is null, which is exactly what we exercise below.
    await prisma.userTier.create({ data: { slug: 'free', name: 'Free' } });

    const res = await server.executeOperation(
      { query: ADMIN_USER_BY_ID, variables: { id: regular.id } },
      ctx(SUPERUSER_USER),
    );

    const data = (res.body as any).singleResult.data;
    expect(data.adminUserById.username).toBe('regular');
    expect(data.adminUserById.email).toBe('user@test.com');
    expect(data.adminUserById.cognitoSub).toBe('sub-regular');
    expect(data.adminUserById.failedAttempts).toBe(0);
    // Every user should fall back to the seeded 'free' tier when no
    // explicit assignment exists.
    expect(data.adminUserById.tier.slug).toBe('free');
  });

  it('allows admin role', async () => {
    const { regular } = await createUsers();

    const res = await server.executeOperation(
      { query: ADMIN_USER_BY_ID, variables: { id: regular.id } },
      ctx(ADMIN_USER),
    );

    expect((res.body as any).singleResult.errors).toBeUndefined();
    expect((res.body as any).singleResult.data.adminUserById.email).toBe('user@test.com');
  });

  it('returns NOT_FOUND for unknown user id', async () => {
    await createUsers();

    const res = await server.executeOperation(
      { query: ADMIN_USER_BY_ID, variables: { id: '00000000-0000-0000-0000-000000000000' } },
      ctx(SUPERUSER_USER),
    );

    const errors = (res.body as any).singleResult.errors;
    expect(errors[0].extensions.code).toBe('NOT_FOUND');
  });
});

const ASSIGN_USER_TIER = `
  mutation AdminAssignUserTier($userId: ID!, $tierId: ID) {
    adminAssignUserTier(userId: $userId, tierId: $tierId) {
      id
      tier { id slug }
    }
  }
`;

describe('adminAssignUserTier', () => {
  it('assigns a tier to a user', async () => {
    const { regular } = await createUsers();
    const tier = await prisma.userTier.create({
      data: { slug: 'pro', name: 'Pro', priceCents: 1999 },
    });

    const res = await server.executeOperation(
      { query: ASSIGN_USER_TIER, variables: { userId: regular.id, tierId: tier.id } },
      ctx(SUPERUSER_USER),
    );

    const data = (res.body as any).singleResult.data;
    expect(data.adminAssignUserTier.tier.slug).toBe('pro');
  });

  it('clears the tier when tierId is null (falls back to free)', async () => {
    const { regular } = await createUsers();
    const free = await prisma.userTier.create({
      data: { slug: 'free', name: 'Free' },
    });
    await prisma.user.update({ where: { id: regular.id }, data: { tierId: free.id } });

    const res = await server.executeOperation(
      { query: ASSIGN_USER_TIER, variables: { userId: regular.id, tierId: null } },
      ctx(SUPERUSER_USER),
    );

    const data = (res.body as any).singleResult.data;
    // tierId on the row is now null, but the User.tier resolver falls back
    // to the 'free' tier so the GraphQL response still reports it.
    expect(data.adminAssignUserTier.tier.slug).toBe('free');
  });

  it('rejects admin role', async () => {
    const { regular } = await createUsers();

    const res = await server.executeOperation(
      { query: ASSIGN_USER_TIER, variables: { userId: regular.id, tierId: null } },
      ctx(ADMIN_USER),
    );

    const errors = (res.body as any).singleResult.errors;
    expect(errors[0].extensions.code).toBe('FORBIDDEN');
  });

  it('returns NOT_FOUND for unknown tier id', async () => {
    const { regular } = await createUsers();

    const res = await server.executeOperation(
      {
        query: ASSIGN_USER_TIER,
        variables: { userId: regular.id, tierId: '00000000-0000-0000-0000-000000000000' },
      },
      ctx(SUPERUSER_USER),
    );

    const errors = (res.body as any).singleResult.errors;
    expect(errors[0].extensions.code).toBe('NOT_FOUND');
  });
});

describe('adminPhotos', () => {
  it('lists photos by moderation status', async () => {
    const { regular } = await createUsers();
    await prisma.photo.create({
      data: {
        userId: regular.id,
        originalUrl: 'http://localhost:4566/a.jpg',
        mimeType: 'image/jpeg',
        moderationStatus: 'pending',
      },
    });
    await prisma.photo.create({
      data: {
        userId: regular.id,
        originalUrl: 'http://localhost:4566/b.jpg',
        mimeType: 'image/jpeg',
        moderationStatus: 'approved',
      },
    });

    const res = await server.executeOperation(
      { query: ADMIN_PHOTOS, variables: { moderationStatus: 'pending' } },
      ctx(ADMIN_USER),
    );

    const data = (res.body as any).singleResult.data;
    expect(data.adminPhotos.totalCount).toBe(1);
    expect(data.adminPhotos.edges[0].node.moderationStatus).toBe('pending');
  });
});

describe('airlines (duplicate IATA/ICAO)', () => {
  it('allows two airlines with the same ICAO code but different names', async () => {
    await createUsers();

    const a = await server.executeOperation(
      {
        query: CREATE_AIRLINE,
        variables: { input: { name: 'Alpha Air', icaoCode: 'AAA', iataCode: '1A' } },
      },
      ctx(ADMIN_USER),
    );
    const b = await server.executeOperation(
      {
        query: CREATE_AIRLINE,
        variables: { input: { name: 'Bravo Air', icaoCode: 'AAA', iataCode: '1B' } },
      },
      ctx(ADMIN_USER),
    );

    expect((a.body as any).singleResult.errors).toBeUndefined();
    expect((b.body as any).singleResult.errors).toBeUndefined();

    const aId = (a.body as any).singleResult.data.createAirline.id;
    const bId = (b.body as any).singleResult.data.createAirline.id;
    expect(aId).not.toBe(bId);

    const rows = await prisma.airline.findMany({ where: { icaoCode: 'AAA' } });
    expect(rows).toHaveLength(2);
  });

  it('allows two airlines with the same IATA code but different names', async () => {
    await createUsers();

    const a = await server.executeOperation(
      {
        query: CREATE_AIRLINE,
        variables: { input: { name: 'Alpha IATA', icaoCode: 'XYZ', iataCode: 'ZZ' } },
      },
      ctx(ADMIN_USER),
    );
    const b = await server.executeOperation(
      {
        query: CREATE_AIRLINE,
        variables: { input: { name: 'Bravo IATA', icaoCode: 'XYW', iataCode: 'ZZ' } },
      },
      ctx(ADMIN_USER),
    );

    expect((a.body as any).singleResult.errors).toBeUndefined();
    expect((b.body as any).singleResult.errors).toBeUndefined();

    const rows = await prisma.airline.findMany({ where: { iataCode: 'ZZ' } });
    expect(rows).toHaveLength(2);
  });

  it('upsertAirline matches on (icaoCode, name) and updates the existing row when both match', async () => {
    await createUsers();

    const created = await server.executeOperation(
      {
        query: UPSERT_AIRLINE,
        variables: { input: { name: 'Gamma Air', icaoCode: 'GAM', iataCode: 'G1' } },
      },
      ctx(ADMIN_USER),
    );
    const createdId = (created.body as any).singleResult.data.upsertAirline.id;

    // Same ICAO + same name → update, not a new row.
    const updated = await server.executeOperation(
      {
        query: UPSERT_AIRLINE,
        variables: { input: { name: 'Gamma Air', icaoCode: 'GAM', iataCode: 'G2' } },
      },
      ctx(ADMIN_USER),
    );
    expect((updated.body as any).singleResult.data.upsertAirline.id).toBe(createdId);
    expect((updated.body as any).singleResult.data.upsertAirline.iataCode).toBe('G2');

    // Same ICAO, different name → a new row.
    const created2 = await server.executeOperation(
      {
        query: UPSERT_AIRLINE,
        variables: { input: { name: 'Gamma Express', icaoCode: 'GAM', iataCode: 'G3' } },
      },
      ctx(ADMIN_USER),
    );
    expect((created2.body as any).singleResult.data.upsertAirline.id).not.toBe(createdId);

    const rows = await prisma.airline.findMany({ where: { icaoCode: 'GAM' } });
    expect(rows).toHaveLength(2);
  });

  it('airline(icaoCode) returns the first match when codes are shared', async () => {
    await createUsers();
    await server.executeOperation(
      { query: CREATE_AIRLINE, variables: { input: { name: 'First', icaoCode: 'DUP' } } },
      ctx(ADMIN_USER),
    );
    await server.executeOperation(
      { query: CREATE_AIRLINE, variables: { input: { name: 'Second', icaoCode: 'DUP' } } },
      ctx(ADMIN_USER),
    );

    const res = await server.executeOperation(
      { query: AIRLINE_BY_ICAO, variables: { icaoCode: 'DUP' } },
      ctx(ADMIN_USER),
    );
    const data = (res.body as any).singleResult.data;
    expect(data.airline).not.toBeNull();
    expect(data.airline.icaoCode).toBe('DUP');
    // Whichever row comes back, it must be one of the two we created.
    expect(['First', 'Second']).toContain(data.airline.name);
  });
});
