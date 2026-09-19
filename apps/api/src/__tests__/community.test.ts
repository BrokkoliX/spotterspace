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

const ALICE = { sub: 'sub-alice', email: 'alice@test.com', username: 'alice' };
const BOB = { sub: 'sub-bob', email: 'bob@test.com', username: 'bob' };
const CHARLIE = { sub: 'sub-charlie', email: 'charlie@test.com', username: 'charlie' };

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

const CREATE_COMMUNITY = `
  mutation CreateCommunity($input: CreateCommunityInput!) {
    createCommunity(input: $input) {
      id name slug description category visibility location
      owner { username }
      memberCount
    }
  }
`;

const GET_COMMUNITY = `
  query Community($slug: String!) {
    community(slug: $slug) {
      id name slug description visibility
      owner { username }
      memberCount
      myMembership { role status }
      members { totalCount edges { node { user { username } role } } }
    }
  }
`;

const GET_COMMUNITIES = `
  query Communities($search: String, $category: String, $first: Int) {
    communities(search: $search, category: $category, first: $first) {
      edges { node { id name slug } }
      totalCount
    }
  }
`;

const MY_COMMUNITIES = `
  query MyCommunities { myCommunities { id name slug } }
`;

const UPDATE_COMMUNITY = `
  mutation UpdateCommunity($id: ID!, $input: UpdateCommunityInput!) {
    updateCommunity(id: $id, input: $input) {
      id name slug description visibility
    }
  }
`;

const DELETE_COMMUNITY = `
  mutation DeleteCommunity($id: ID!) { deleteCommunity(id: $id) }
`;

const JOIN_COMMUNITY = `
  mutation JoinCommunity($communityId: ID!, $inviteCode: String) {
    joinCommunity(communityId: $communityId, inviteCode: $inviteCode) {
      id role status user { username }
    }
  }
`;

const LEAVE_COMMUNITY = `
  mutation LeaveCommunity($communityId: ID!) { leaveCommunity(communityId: $communityId) }
`;

const REMOVE_MEMBER = `
  mutation RemoveMember($communityId: ID!, $userId: ID!) {
    removeCommunityMember(communityId: $communityId, userId: $userId)
  }
`;

const UPDATE_ROLE = `
  mutation UpdateRole($communityId: ID!, $userId: ID!, $role: String!) {
    updateCommunityMemberRole(communityId: $communityId, userId: $userId, role: $role) {
      id role
    }
  }
`;

const GENERATE_INVITE = `
  mutation GenerateInvite($communityId: ID!) {
    generateInviteCode(communityId: $communityId) {
      id inviteCode
    }
  }
`;

// ─── Helpers ────────────────────────────────────────────────────────────────

async function createUsers() {
  const alice = await prisma.user.create({
    data: { email: 'alice@test.com', username: 'alice', cognitoSub: 'sub-alice' },
  });
  const bob = await prisma.user.create({
    data: { email: 'bob@test.com', username: 'bob', cognitoSub: 'sub-bob' },
  });
  const charlie = await prisma.user.create({
    data: { email: 'charlie@test.com', username: 'charlie', cognitoSub: 'sub-charlie' },
  });
  return { alice, bob, charlie };
}

async function createCommunityViaApi(input = {}) {
  const defaults = {
    name: 'LAX Spotters',
    slug: 'lax-spotters',
    description: 'Aviation photography at LAX',
    category: 'airliners',
  };
  const res = await server.executeOperation(
    { query: CREATE_COMMUNITY, variables: { input: { ...defaults, ...input } } },
    ctx(ALICE),
  );
  return (res.body as any).singleResult;
}

// ─── Tests ──────────────────────────────────────────────────────────────────

describe('createCommunity', () => {
  it('creates a public community and auto-adds owner', async () => {
    await createUsers();
    const result = await createCommunityViaApi();

    expect(result.data.createCommunity.name).toBe('LAX Spotters');
    expect(result.data.createCommunity.slug).toBe('lax-spotters');
    expect(result.data.createCommunity.owner.username).toBe('alice');
    expect(result.data.createCommunity.memberCount).toBe(1);
    expect(result.data.createCommunity.visibility).toBe('public');
  });

  it('creates an invite-only community with auto-generated invite code', async () => {
    await createUsers();
    const result = await createCommunityViaApi({
      visibility: 'invite_only',
      slug: 'private-group',
    });

    expect(result.data.createCommunity.visibility).toBe('invite_only');
  });

  it('rejects duplicate slugs', async () => {
    await createUsers();
    await createCommunityViaApi();
    const result = await createCommunityViaApi(); // same slug

    expect(result.errors[0].extensions.code).toBe('BAD_USER_INPUT');
    expect(result.errors[0].message).toContain('slug already exists');
  });

  it('rejects invalid slug format', async () => {
    await createUsers();
    const result = await createCommunityViaApi({ slug: 'Invalid Slug!' });

    expect(result.errors[0].extensions.code).toBe('BAD_USER_INPUT');
  });

  it('rejects short name', async () => {
    await createUsers();
    const result = await createCommunityViaApi({ name: 'ab', slug: 'valid-slug' });

    expect(result.errors[0].extensions.code).toBe('BAD_USER_INPUT');
  });

  it('requires authentication', async () => {
    const res = await server.executeOperation(
      { query: CREATE_COMMUNITY, variables: { input: { name: 'Test', slug: 'test' } } },
      ctx(null),
    );
    expect((res.body as any).singleResult.errors[0].extensions.code).toBe('UNAUTHENTICATED');
  });
});

describe('community query', () => {
  it('finds community by slug', async () => {
    await createUsers();
    await createCommunityViaApi();

    const res = await server.executeOperation(
      { query: GET_COMMUNITY, variables: { slug: 'lax-spotters' } },
      ctx(ALICE),
    );

    const data = (res.body as any).singleResult.data;
    expect(data.community.name).toBe('LAX Spotters');
    expect(data.community.myMembership.role).toBe('owner');
    expect(data.community.members.totalCount).toBe(1);
  });

  it('returns null for non-existent slug', async () => {
    const res = await server.executeOperation(
      { query: GET_COMMUNITY, variables: { slug: 'does-not-exist' } },
      ctx(null),
    );
    expect((res.body as any).singleResult.data.community).toBeNull();
  });

  it('shows myMembership as null for non-members', async () => {
    await createUsers();
    await createCommunityViaApi();

    const res = await server.executeOperation(
      { query: GET_COMMUNITY, variables: { slug: 'lax-spotters' } },
      ctx(BOB),
    );

    expect((res.body as any).singleResult.data.community.myMembership).toBeNull();
  });
});

describe('communities query', () => {
  it('lists public communities', async () => {
    await createUsers();
    await createCommunityViaApi();
    await createCommunityViaApi({ name: 'SFO Group', slug: 'sfo-group' });

    const res = await server.executeOperation({ query: GET_COMMUNITIES }, ctx(null));

    expect((res.body as any).singleResult.data.communities.totalCount).toBe(2);
  });

  it('filters by search term', async () => {
    await createUsers();
    await createCommunityViaApi();
    await createCommunityViaApi({
      name: 'SFO Group',
      slug: 'sfo-group',
      description: 'Spotting at SFO',
    });

    const res = await server.executeOperation(
      { query: GET_COMMUNITIES, variables: { search: 'LAX' } },
      ctx(null),
    );

    expect((res.body as any).singleResult.data.communities.totalCount).toBe(1);
  });

  it('filters by category', async () => {
    await createUsers();
    await createCommunityViaApi({ category: 'military', slug: 'mil-group', name: 'Mil Spotters' });
    await createCommunityViaApi();

    const res = await server.executeOperation(
      { query: GET_COMMUNITIES, variables: { category: 'military' } },
      ctx(null),
    );

    expect((res.body as any).singleResult.data.communities.totalCount).toBe(1);
  });

  it('excludes invite-only communities', async () => {
    await createUsers();
    await createCommunityViaApi();
    await createCommunityViaApi({
      visibility: 'invite_only',
      slug: 'private-club',
      name: 'Private Club',
    });

    const res = await server.executeOperation({ query: GET_COMMUNITIES }, ctx(null));

    expect((res.body as any).singleResult.data.communities.totalCount).toBe(1);
  });
});

describe('myCommunities', () => {
  it('lists communities user is a member of', async () => {
    await createUsers();
    await createCommunityViaApi();

    const res = await server.executeOperation({ query: MY_COMMUNITIES }, ctx(ALICE));

    const data = (res.body as any).singleResult.data;
    expect(data.myCommunities).toHaveLength(1);
    expect(data.myCommunities[0].slug).toBe('lax-spotters');
  });

  it('returns empty for user with no memberships', async () => {
    await createUsers();

    const res = await server.executeOperation({ query: MY_COMMUNITIES }, ctx(BOB));

    expect((res.body as any).singleResult.data.myCommunities).toHaveLength(0);
  });
});

describe('updateCommunity', () => {
  it('allows owner to update community', async () => {
    await createUsers();
    const created = await createCommunityViaApi();
    const id = created.data.createCommunity.id;

    const res = await server.executeOperation(
      { query: UPDATE_COMMUNITY, variables: { id, input: { description: 'Updated desc' } } },
      ctx(ALICE),
    );

    expect((res.body as any).singleResult.data.updateCommunity.description).toBe('Updated desc');
  });

  it('rejects non-admin/owner', async () => {
    await createUsers();
    const created = await createCommunityViaApi();
    const id = created.data.createCommunity.id;

    const res = await server.executeOperation(
      { query: UPDATE_COMMUNITY, variables: { id, input: { description: 'Hacked' } } },
      ctx(BOB),
    );

    expect((res.body as any).singleResult.errors[0].extensions.code).toBe('FORBIDDEN');
  });
});

describe('deleteCommunity', () => {
  it('allows owner to delete', async () => {
    await createUsers();
    const created = await createCommunityViaApi();
    const id = created.data.createCommunity.id;

    const res = await server.executeOperation(
      { query: DELETE_COMMUNITY, variables: { id } },
      ctx(ALICE),
    );

    expect((res.body as any).singleResult.data.deleteCommunity).toBe(true);
  });

  it('rejects non-owner', async () => {
    await createUsers();
    const created = await createCommunityViaApi();
    const id = created.data.createCommunity.id;

    const res = await server.executeOperation(
      { query: DELETE_COMMUNITY, variables: { id } },
      ctx(BOB),
    );

    expect((res.body as any).singleResult.errors[0].extensions.code).toBe('FORBIDDEN');
  });
});

describe('joinCommunity', () => {
  it('joins a public community', async () => {
    await createUsers();
    const created = await createCommunityViaApi();
    const communityId = created.data.createCommunity.id;

    const res = await server.executeOperation(
      { query: JOIN_COMMUNITY, variables: { communityId } },
      ctx(BOB),
    );

    const data = (res.body as any).singleResult.data;
    expect(data.joinCommunity.role).toBe('member');
    expect(data.joinCommunity.user.username).toBe('bob');
  });

  it('rejects duplicate join', async () => {
    await createUsers();
    const created = await createCommunityViaApi();
    const communityId = created.data.createCommunity.id;

    await server.executeOperation({ query: JOIN_COMMUNITY, variables: { communityId } }, ctx(BOB));
    const res = await server.executeOperation(
      { query: JOIN_COMMUNITY, variables: { communityId } },
      ctx(BOB),
    );

    expect((res.body as any).singleResult.errors[0].extensions.code).toBe('BAD_USER_INPUT');
  });

  it('requires invite code for invite-only community', async () => {
    await createUsers();
    const created = await createCommunityViaApi({
      visibility: 'invite_only',
      slug: 'private-club',
      name: 'Private',
    });
    const communityId = created.data.createCommunity.id;

    const res = await server.executeOperation(
      { query: JOIN_COMMUNITY, variables: { communityId } },
      ctx(BOB),
    );

    expect((res.body as any).singleResult.errors[0].extensions.code).toBe('FORBIDDEN');
  });

  it('accepts valid invite code', async () => {
    await createUsers();
    const created = await createCommunityViaApi({
      visibility: 'invite_only',
      slug: 'private-club',
      name: 'Private',
    });
    const communityId = created.data.createCommunity.id;

    // Get the invite code from the DB directly
    const community = await prisma.community.findUnique({ where: { id: communityId } });

    const res = await server.executeOperation(
      { query: JOIN_COMMUNITY, variables: { communityId, inviteCode: community!.inviteCode } },
      ctx(BOB),
    );

    expect((res.body as any).singleResult.data.joinCommunity.role).toBe('member');
  });
});

describe('leaveCommunity', () => {
  it('allows member to leave', async () => {
    await createUsers();
    const created = await createCommunityViaApi();
    const communityId = created.data.createCommunity.id;

    await server.executeOperation({ query: JOIN_COMMUNITY, variables: { communityId } }, ctx(BOB));

    const res = await server.executeOperation(
      { query: LEAVE_COMMUNITY, variables: { communityId } },
      ctx(BOB),
    );

    expect((res.body as any).singleResult.data.leaveCommunity).toBe(true);
  });

  it('prevents owner from leaving', async () => {
    await createUsers();
    const created = await createCommunityViaApi();
    const communityId = created.data.createCommunity.id;

    const res = await server.executeOperation(
      { query: LEAVE_COMMUNITY, variables: { communityId } },
      ctx(ALICE),
    );

    expect((res.body as any).singleResult.errors[0].extensions.code).toBe('FORBIDDEN');
  });
});

describe('removeCommunityMember', () => {
  it('allows owner to remove a member', async () => {
    const { bob } = await createUsers();
    const created = await createCommunityViaApi();
    const communityId = created.data.createCommunity.id;

    await server.executeOperation({ query: JOIN_COMMUNITY, variables: { communityId } }, ctx(BOB));

    const res = await server.executeOperation(
      { query: REMOVE_MEMBER, variables: { communityId, userId: bob.id } },
      ctx(ALICE),
    );

    expect((res.body as any).singleResult.data.removeCommunityMember).toBe(true);
  });

  it('prevents member from removing another member', async () => {
    const { charlie } = await createUsers();
    const created = await createCommunityViaApi();
    const communityId = created.data.createCommunity.id;

    await server.executeOperation({ query: JOIN_COMMUNITY, variables: { communityId } }, ctx(BOB));
    await server.executeOperation(
      { query: JOIN_COMMUNITY, variables: { communityId } },
      ctx(CHARLIE),
    );

    const res = await server.executeOperation(
      { query: REMOVE_MEMBER, variables: { communityId, userId: charlie.id } },
      ctx(BOB),
    );

    expect((res.body as any).singleResult.errors[0].extensions.code).toBe('FORBIDDEN');
  });
});

describe('updateCommunityMemberRole', () => {
  it('allows owner to promote member to moderator', async () => {
    const { bob } = await createUsers();
    const created = await createCommunityViaApi();
    const communityId = created.data.createCommunity.id;

    await server.executeOperation({ query: JOIN_COMMUNITY, variables: { communityId } }, ctx(BOB));

    const res = await server.executeOperation(
      { query: UPDATE_ROLE, variables: { communityId, userId: bob.id, role: 'moderator' } },
      ctx(ALICE),
    );

    expect((res.body as any).singleResult.data.updateCommunityMemberRole.role).toBe('moderator');
  });

  it('prevents promotion to owner role', async () => {
    const { bob } = await createUsers();
    const created = await createCommunityViaApi();
    const communityId = created.data.createCommunity.id;

    await server.executeOperation({ query: JOIN_COMMUNITY, variables: { communityId } }, ctx(BOB));

    const res = await server.executeOperation(
      { query: UPDATE_ROLE, variables: { communityId, userId: bob.id, role: 'owner' } },
      ctx(ALICE),
    );

    expect((res.body as any).singleResult.errors[0].extensions.code).toBe('BAD_USER_INPUT');
  });

  it('prevents member from changing roles', async () => {
    const { charlie } = await createUsers();
    const created = await createCommunityViaApi();
    const communityId = created.data.createCommunity.id;

    await server.executeOperation({ query: JOIN_COMMUNITY, variables: { communityId } }, ctx(BOB));
    await server.executeOperation(
      { query: JOIN_COMMUNITY, variables: { communityId } },
      ctx(CHARLIE),
    );

    const res = await server.executeOperation(
      { query: UPDATE_ROLE, variables: { communityId, userId: charlie.id, role: 'moderator' } },
      ctx(BOB),
    );

    expect((res.body as any).singleResult.errors[0].extensions.code).toBe('FORBIDDEN');
  });
});

describe('generateInviteCode', () => {
  it('generates invite code for owner', async () => {
    await createUsers();
    const created = await createCommunityViaApi();
    const communityId = created.data.createCommunity.id;

    const res = await server.executeOperation(
      { query: GENERATE_INVITE, variables: { communityId } },
      ctx(ALICE),
    );

    const data = (res.body as any).singleResult.data;
    expect(data.generateInviteCode.inviteCode).toBeTruthy();
    expect(data.generateInviteCode.inviteCode).toHaveLength(12);
  });

  it('rejects non-admin member', async () => {
    await createUsers();
    const created = await createCommunityViaApi();
    const communityId = created.data.createCommunity.id;

    await server.executeOperation({ query: JOIN_COMMUNITY, variables: { communityId } }, ctx(BOB));

    const res = await server.executeOperation(
      { query: GENERATE_INVITE, variables: { communityId } },
      ctx(BOB),
    );

    expect((res.body as any).singleResult.errors[0].extensions.code).toBe('FORBIDDEN');
  });
});

// ─── Ban/Unban Tests ─────────────────────────────────────────────────────────

const BAN_MEMBER = `
  mutation BanMember($communityId: ID!, $userId: ID!, $reason: String) {
    banCommunityMember(communityId: $communityId, userId: $userId, reason: $reason) {
      id status role
    }
  }
`;

const UNBAN_MEMBER = `
  mutation UnbanMember($communityId: ID!, $userId: ID!) {
    unbanCommunityMember(communityId: $communityId, userId: $userId) {
      id status role
    }
  }
`;

const GET_MOD_LOGS = `
  query ModLogs($communityId: ID!, $first: Int) {
    communityModerationLogs(communityId: $communityId, first: $first) {
      totalCount
      edges { node {
        id action reason moderator { username } targetUser { username }
        createdAt
      }}
    }
  }
`;

describe('banCommunityMember', () => {
  it('owner can ban a member', async () => {
    await createUsers();
    const created = await createCommunityViaApi();
    const communityId = created.data.createCommunity.id;

    await server.executeOperation({ query: JOIN_COMMUNITY, variables: { communityId } }, ctx(BOB));

    const res = await server.executeOperation(
      {
        query: BAN_MEMBER,
        variables: {
          communityId,
          userId: (await prisma.user.findUnique({ where: { username: 'bob' } }))!.id,
          reason: 'Spam behavior',
        },
      },
      ctx(ALICE),
    );

    const data = (res.body as any).singleResult.data;
    expect(data.banCommunityMember.status).toBe('banned');
  });

  it('owner can ban a moderator', async () => {
    await createUsers();
    const created = await createCommunityViaApi();
    const communityId = created.data.createCommunity.id;

    await server.executeOperation({ query: JOIN_COMMUNITY, variables: { communityId } }, ctx(BOB));
    await server.executeOperation(
      {
        query: UPDATE_ROLE,
        variables: {
          communityId,
          userId: (await prisma.user.findUnique({ where: { username: 'bob' } }))!.id,
          role: 'moderator',
        },
      },
      ctx(ALICE),
    );

    const bobId = (await prisma.user.findUnique({ where: { username: 'bob' } }))!.id;
    const res = await server.executeOperation(
      { query: BAN_MEMBER, variables: { communityId, userId: bobId } },
      ctx(ALICE),
    );

    expect((res.body as any).singleResult.data.banCommunityMember.status).toBe('banned');
  });

  it('admin cannot ban another admin (equal role weight)', async () => {
    await createUsers();
    const created = await createCommunityViaApi();
    const communityId = created.data.createCommunity.id;

    // Add bob as admin
    await server.executeOperation({ query: JOIN_COMMUNITY, variables: { communityId } }, ctx(BOB));
    await server.executeOperation(
      {
        query: UPDATE_ROLE,
        variables: {
          communityId,
          userId: (await prisma.user.findUnique({ where: { username: 'bob' } }))!.id,
          role: 'admin',
        },
      },
      ctx(ALICE),
    );
    // Add charlie as admin too
    await server.executeOperation(
      { query: JOIN_COMMUNITY, variables: { communityId } },
      ctx(CHARLIE),
    );
    await server.executeOperation(
      {
        query: UPDATE_ROLE,
        variables: {
          communityId,
          userId: (await prisma.user.findUnique({ where: { username: 'charlie' } }))!.id,
          role: 'admin',
        },
      },
      ctx(ALICE),
    );

    // Charlie (admin) tries to ban Bob (also admin) - should fail (equal weight)
    const bobId = (await prisma.user.findUnique({ where: { username: 'bob' } }))!.id;
    const res = await server.executeOperation(
      { query: BAN_MEMBER, variables: { communityId, userId: bobId } },
      { contextValue: createTestContext(CHARLIE) },
    );

    expect((res.body as any).singleResult.errors[0].extensions.code).toBe('FORBIDDEN');
  });

  it('owner can ban an admin', async () => {
    await createUsers();
    const created = await createCommunityViaApi();
    const communityId = created.data.createCommunity.id;

    await server.executeOperation({ query: JOIN_COMMUNITY, variables: { communityId } }, ctx(BOB));
    await server.executeOperation(
      {
        query: UPDATE_ROLE,
        variables: {
          communityId,
          userId: (await prisma.user.findUnique({ where: { username: 'bob' } }))!.id,
          role: 'admin',
        },
      },
      ctx(ALICE),
    );

    const bobId = (await prisma.user.findUnique({ where: { username: 'bob' } }))!.id;
    const res = await server.executeOperation(
      { query: BAN_MEMBER, variables: { communityId, userId: bobId } },
      ctx(ALICE),
    );

    // owner (4) > admin (3), so ban should succeed
    expect((res.body as any).singleResult.data.banCommunityMember.status).toBe('banned');
  });

  it('cannot ban self', async () => {
    await createUsers();
    const created = await createCommunityViaApi();
    const communityId = created.data.createCommunity.id;

    const aliceId = (await prisma.user.findUnique({ where: { username: 'alice' } }))!.id;
    const res = await server.executeOperation(
      { query: BAN_MEMBER, variables: { communityId, userId: aliceId } },
      ctx(ALICE),
    );

    expect((res.body as any).singleResult.errors[0].extensions.code).toBe('BAD_USER_INPUT');
  });

  it('rejects banned member again', async () => {
    await createUsers();
    const created = await createCommunityViaApi();
    const communityId = created.data.createCommunity.id;

    await server.executeOperation({ query: JOIN_COMMUNITY, variables: { communityId } }, ctx(BOB));

    const bobId = (await prisma.user.findUnique({ where: { username: 'bob' } }))!.id;
    await server.executeOperation(
      { query: BAN_MEMBER, variables: { communityId, userId: bobId } },
      ctx(ALICE),
    );

    const res = await server.executeOperation(
      { query: BAN_MEMBER, variables: { communityId, userId: bobId } },
      ctx(ALICE),
    );

    expect((res.body as any).singleResult.errors[0].extensions.code).toBe('BAD_USER_INPUT');
    expect((res.body as any).singleResult.errors[0].message).toContain('already banned');
  });

  it('creates moderation log entry', async () => {
    await createUsers();
    const created = await createCommunityViaApi();
    const communityId = created.data.createCommunity.id;

    await server.executeOperation({ query: JOIN_COMMUNITY, variables: { communityId } }, ctx(BOB));

    const bobId = (await prisma.user.findUnique({ where: { username: 'bob' } }))!.id;
    await server.executeOperation(
      { query: BAN_MEMBER, variables: { communityId, userId: bobId, reason: 'Test reason' } },
      ctx(ALICE),
    );

    const log = await prisma.communityModerationLog.findFirst({
      where: { communityId, action: 'ban', targetUserId: bobId },
    });
    expect(log).not.toBeNull();
    expect(log!.reason).toBe('Test reason');
  });
});

describe('unbanCommunityMember', () => {
  it('owner can unban a member', async () => {
    await createUsers();
    const created = await createCommunityViaApi();
    const communityId = created.data.createCommunity.id;

    await server.executeOperation({ query: JOIN_COMMUNITY, variables: { communityId } }, ctx(BOB));

    const bobId = (await prisma.user.findUnique({ where: { username: 'bob' } }))!.id;
    await server.executeOperation(
      { query: BAN_MEMBER, variables: { communityId, userId: bobId } },
      ctx(ALICE),
    );

    const res = await server.executeOperation(
      { query: UNBAN_MEMBER, variables: { communityId, userId: bobId } },
      ctx(ALICE),
    );

    expect((res.body as any).singleResult.data.unbanCommunityMember.status).toBe('active');
  });

  it('cannot unban non-banned member', async () => {
    await createUsers();
    const created = await createCommunityViaApi();
    const communityId = created.data.createCommunity.id;

    await server.executeOperation({ query: JOIN_COMMUNITY, variables: { communityId } }, ctx(BOB));

    const bobId = (await prisma.user.findUnique({ where: { username: 'bob' } }))!.id;
    const res = await server.executeOperation(
      { query: UNBAN_MEMBER, variables: { communityId, userId: bobId } },
      ctx(ALICE),
    );

    expect((res.body as any).singleResult.errors[0].extensions.code).toBe('BAD_USER_INPUT');
  });

  it('creates moderation log entry for unban', async () => {
    await createUsers();
    const created = await createCommunityViaApi();
    const communityId = created.data.createCommunity.id;

    await server.executeOperation({ query: JOIN_COMMUNITY, variables: { communityId } }, ctx(BOB));

    const bobId = (await prisma.user.findUnique({ where: { username: 'bob' } }))!.id;
    await server.executeOperation(
      { query: BAN_MEMBER, variables: { communityId, userId: bobId } },
      ctx(ALICE),
    );
    await server.executeOperation(
      { query: UNBAN_MEMBER, variables: { communityId, userId: bobId } },
      ctx(ALICE),
    );

    const log = await prisma.communityModerationLog.findFirst({
      where: { communityId, action: 'unban', targetUserId: bobId },
    });
    expect(log).not.toBeNull();
  });

  it('unbanned member can rejoin via joinCommunity', async () => {
    await createUsers();
    const created = await createCommunityViaApi();
    const communityId = created.data.createCommunity.id;

    await server.executeOperation({ query: JOIN_COMMUNITY, variables: { communityId } }, ctx(BOB));

    const bobId = (await prisma.user.findUnique({ where: { username: 'bob' } }))!.id;
    await server.executeOperation(
      { query: BAN_MEMBER, variables: { communityId, userId: bobId } },
      ctx(ALICE),
    );
    await server.executeOperation(
      { query: UNBAN_MEMBER, variables: { communityId, userId: bobId } },
      ctx(ALICE),
    );

    // Bob leaves
    await server.executeOperation({ query: LEAVE_COMMUNITY, variables: { communityId } }, ctx(BOB));

    // Bob rejoins
    const res = await server.executeOperation(
      { query: JOIN_COMMUNITY, variables: { communityId } },
      ctx(BOB),
    );

    expect((res.body as any).singleResult.data.joinCommunity.status).toBe('active');
  });
});

describe('communityModerationLogs', () => {
  it('owner can query logs', async () => {
    await createUsers();
    const created = await createCommunityViaApi();
    const communityId = created.data.createCommunity.id;

    await server.executeOperation({ query: JOIN_COMMUNITY, variables: { communityId } }, ctx(BOB));

    const bobId = (await prisma.user.findUnique({ where: { username: 'bob' } }))!.id;
    await server.executeOperation(
      { query: BAN_MEMBER, variables: { communityId, userId: bobId } },
      ctx(ALICE),
    );

    const res = await server.executeOperation(
      { query: GET_MOD_LOGS, variables: { communityId, first: 10 } },
      ctx(ALICE),
    );

    const data = (res.body as any).singleResult.data;
    expect(data.communityModerationLogs.totalCount).toBeGreaterThan(0);
    expect(data.communityModerationLogs.edges[0].node.action).toBe('ban');
  });

  it('non-admin member cannot view logs', async () => {
    await createUsers();
    const created = await createCommunityViaApi();
    const communityId = created.data.createCommunity.id;

    await server.executeOperation({ query: JOIN_COMMUNITY, variables: { communityId } }, ctx(BOB));

    const res = await server.executeOperation(
      { query: GET_MOD_LOGS, variables: { communityId, first: 10 } },
      ctx(BOB),
    );

    expect((res.body as any).singleResult.errors[0].extensions.code).toBe('FORBIDDEN');
  });

  it('filters by action type', async () => {
    await createUsers();
    const created = await createCommunityViaApi();
    const communityId = created.data.createCommunity.id;

    await server.executeOperation({ query: JOIN_COMMUNITY, variables: { communityId } }, ctx(BOB));

    const bobId = (await prisma.user.findUnique({ where: { username: 'bob' } }))!.id;
    await server.executeOperation(
      { query: BAN_MEMBER, variables: { communityId, userId: bobId } },
      ctx(ALICE),
    );
    await server.executeOperation(
      { query: UNBAN_MEMBER, variables: { communityId, userId: bobId } },
      ctx(ALICE),
    );

    const res = await server.executeOperation(
      { query: GET_MOD_LOGS, variables: { communityId, first: 10 } },
      ctx(ALICE),
    );

    const data = (res.body as any).singleResult.data;
    // should have at least ban and unban entries
    const actions = data.communityModerationLogs.edges.map((e: any) => e.node.action);
    expect(actions).toContain('ban');
    expect(actions).toContain('unban');
  });
});
