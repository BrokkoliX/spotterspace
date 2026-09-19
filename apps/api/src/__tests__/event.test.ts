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

const GET_EVENTS = `
  query CommunityEvents($communityId: ID!, $first: Int, $after: String, $includePast: Boolean) {
    communityEvents(communityId: $communityId, first: $first, after: $after, includePast: $includePast) {
      edges { cursor node { id title location startsAt endsAt maxAttendees attendeeCount isFull } }
      pageInfo { hasNextPage endCursor }
      totalCount
    }
  }
`;

const GET_EVENT = `
  query CommunityEvent($id: ID!) {
    communityEvent(id: $id) {
      id title description location startsAt endsAt maxAttendees attendeeCount isFull
      organizer { username }
      myRsvp { id status }
    }
  }
`;

const CREATE_EVENT = `
  mutation CreateCommunityEvent($communityId: ID!, $input: CreateCommunityEventInput!) {
    createCommunityEvent(communityId: $communityId, input: $input) {
      id title description location startsAt endsAt maxAttendees
      organizer { username }
    }
  }
`;

const UPDATE_EVENT = `
  mutation UpdateCommunityEvent($id: ID!, $input: UpdateCommunityEventInput!) {
    updateCommunityEvent(id: $id, input: $input) {
      id title description location maxAttendees
    }
  }
`;

const DELETE_EVENT = `
  mutation DeleteCommunityEvent($id: ID!) { deleteCommunityEvent(id: $id) }
`;

const RSVP = `
  mutation RsvpEvent($eventId: ID!, $status: String!) {
    rsvpEvent(eventId: $eventId, status: $status) { id status eventId }
  }
`;

const CANCEL_RSVP = `
  mutation CancelRsvp($eventId: ID!) { cancelRsvp(eventId: $eventId) }
`;

// ─── Setup helpers ───────────────────────────────────────────────────────────

async function seedUsers() {
  const alice = await prisma.user.create({
    data: { cognitoSub: ALICE.sub, email: ALICE.email, username: ALICE.username },
  });
  const bob = await prisma.user.create({
    data: { cognitoSub: BOB.sub, email: BOB.email, username: BOB.username },
  });
  const charlie = await prisma.user.create({
    data: { cognitoSub: CHARLIE.sub, email: CHARLIE.email, username: CHARLIE.username },
  });
  return { alice, bob, charlie };
}

async function seedCommunity(ownerId: string) {
  const community = await prisma.community.create({
    data: {
      name: 'Test Community',
      slug: 'test-community',
      ownerId,
      members: {
        create: { userId: ownerId, role: 'owner' },
      },
    },
  });
  return community;
}

async function addMember(
  communityId: string,
  userId: string,
  role: import('@prisma/client').CommunityRole = 'member',
) {
  return prisma.communityMember.create({
    data: { communityId, userId, role },
  });
}

const FUTURE = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString();
const PAST = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
const FUTURE_END = new Date(Date.now() + 8 * 24 * 60 * 60 * 1000).toISOString();

async function seedEvent(
  communityId: string,
  organizerId: string,
  overrides: Partial<{
    startsAt: string;
    endsAt: string;
    maxAttendees: number;
    title: string;
  }> = {},
) {
  return prisma.communityEvent.create({
    data: {
      communityId,
      organizerId,
      title: overrides.title ?? 'Planespotting Day',
      description: 'Come spot planes with us!',
      location: 'Terminal 3 Roof',
      startsAt: new Date(overrides.startsAt ?? FUTURE),
      endsAt: overrides.endsAt ? new Date(overrides.endsAt) : null,
      maxAttendees: overrides.maxAttendees,
    },
  });
}

// ─── Tests ───────────────────────────────────────────────────────────────────

describe('communityEvents query', () => {
  it('returns upcoming events for a community', async () => {
    const { alice } = await seedUsers();
    const community = await seedCommunity(alice.id);
    await seedEvent(community.id, alice.id);

    const res = await server.executeOperation(
      { query: GET_EVENTS, variables: { communityId: community.id } },
      ctx(),
    );
    expect(res.body.kind).toBe('single');
    if (res.body.kind !== 'single') return;
    const data = res.body.singleResult.data?.communityEvents as {
      edges: { node: { title: string } }[];
      totalCount: number;
    };
    expect(data.edges).toHaveLength(1);
    expect(data.edges[0].node.title).toBe('Planespotting Day');
    expect(data.totalCount).toBe(1);
  });

  it('excludes past events by default', async () => {
    const { alice } = await seedUsers();
    const community = await seedCommunity(alice.id);
    await seedEvent(community.id, alice.id, { startsAt: PAST });

    const res = await server.executeOperation(
      { query: GET_EVENTS, variables: { communityId: community.id } },
      ctx(),
    );
    if (res.body.kind !== 'single') return;
    const data = res.body.singleResult.data?.communityEvents as { edges: unknown[] };
    expect(data.edges).toHaveLength(0);
  });

  it('includes past events when includePast is true', async () => {
    const { alice } = await seedUsers();
    const community = await seedCommunity(alice.id);
    await seedEvent(community.id, alice.id, { startsAt: PAST });

    const res = await server.executeOperation(
      { query: GET_EVENTS, variables: { communityId: community.id, includePast: true } },
      ctx(),
    );
    if (res.body.kind !== 'single') return;
    const data = res.body.singleResult.data?.communityEvents as { edges: unknown[] };
    expect(data.edges).toHaveLength(1);
  });

  it('returns empty list for community with no events', async () => {
    const { alice } = await seedUsers();
    const community = await seedCommunity(alice.id);

    const res = await server.executeOperation(
      { query: GET_EVENTS, variables: { communityId: community.id } },
      ctx(),
    );
    if (res.body.kind !== 'single') return;
    const data = res.body.singleResult.data?.communityEvents as {
      edges: unknown[];
      totalCount: number;
    };
    expect(data.edges).toHaveLength(0);
    expect(data.totalCount).toBe(0);
  });
});

describe('communityEvent query', () => {
  it('returns a single event by ID', async () => {
    const { alice } = await seedUsers();
    const community = await seedCommunity(alice.id);
    const event = await seedEvent(community.id, alice.id);

    const res = await server.executeOperation(
      { query: GET_EVENT, variables: { id: event.id } },
      ctx(),
    );
    if (res.body.kind !== 'single') return;
    const data = res.body.singleResult.data?.communityEvent as {
      id: string;
      title: string;
      organizer: { username: string };
    };
    expect(data.id).toBe(event.id);
    expect(data.title).toBe('Planespotting Day');
    expect(data.organizer.username).toBe('alice');
  });

  it('returns null for non-existent event', async () => {
    const res = await server.executeOperation(
      { query: GET_EVENT, variables: { id: '00000000-0000-0000-0000-000000000000' } },
      ctx(),
    );
    if (res.body.kind !== 'single') return;
    expect(res.body.singleResult.data?.communityEvent).toBeNull();
  });
});

describe('createCommunityEvent mutation', () => {
  it('owner can create an event', async () => {
    const { alice } = await seedUsers();
    const community = await seedCommunity(alice.id);

    const res = await server.executeOperation(
      {
        query: CREATE_EVENT,
        variables: {
          communityId: community.id,
          input: { title: 'Airshow 2026', startsAt: FUTURE, endsAt: FUTURE_END, location: 'LLBG' },
        },
      },
      ctx(ALICE),
    );
    if (res.body.kind !== 'single') return;
    expect(res.body.singleResult.errors).toBeUndefined();
    const data = res.body.singleResult.data?.createCommunityEvent as {
      title: string;
      location: string;
      organizer: { username: string };
    };
    expect(data.title).toBe('Airshow 2026');
    expect(data.location).toBe('LLBG');
    expect(data.organizer.username).toBe('alice');
  });

  it('admin can create an event', async () => {
    const { alice, bob } = await seedUsers();
    const community = await seedCommunity(alice.id);
    await addMember(community.id, bob.id, 'admin');

    const res = await server.executeOperation(
      {
        query: CREATE_EVENT,
        variables: { communityId: community.id, input: { title: 'Admin Event', startsAt: FUTURE } },
      },
      ctx(BOB),
    );
    if (res.body.kind !== 'single') return;
    expect(res.body.singleResult.errors).toBeUndefined();
  });

  it('regular member cannot create an event', async () => {
    const { alice, bob } = await seedUsers();
    const community = await seedCommunity(alice.id);
    await addMember(community.id, bob.id, 'member');

    const res = await server.executeOperation(
      {
        query: CREATE_EVENT,
        variables: {
          communityId: community.id,
          input: { title: 'Member Event', startsAt: FUTURE },
        },
      },
      ctx(BOB),
    );
    if (res.body.kind !== 'single') return;
    expect(res.body.singleResult.errors).toBeDefined();
    expect(res.body.singleResult.errors![0].extensions?.code).toBe('FORBIDDEN');
  });

  it('unauthenticated user cannot create an event', async () => {
    const { alice } = await seedUsers();
    const community = await seedCommunity(alice.id);

    const res = await server.executeOperation(
      {
        query: CREATE_EVENT,
        variables: { communityId: community.id, input: { title: 'Event', startsAt: FUTURE } },
      },
      ctx(),
    );
    if (res.body.kind !== 'single') return;
    expect(res.body.singleResult.errors).toBeDefined();
  });

  it('rejects endsAt before startsAt', async () => {
    const { alice } = await seedUsers();
    const community = await seedCommunity(alice.id);

    const res = await server.executeOperation(
      {
        query: CREATE_EVENT,
        variables: {
          communityId: community.id,
          input: { title: 'Bad Dates', startsAt: FUTURE_END, endsAt: FUTURE },
        },
      },
      ctx(ALICE),
    );
    if (res.body.kind !== 'single') return;
    expect(res.body.singleResult.errors).toBeDefined();
    expect(res.body.singleResult.errors![0].message).toMatch(/endsAt must be after/);
  });
});

describe('updateCommunityEvent mutation', () => {
  it('organizer can update their event', async () => {
    const { alice } = await seedUsers();
    const community = await seedCommunity(alice.id);
    const event = await seedEvent(community.id, alice.id);

    const res = await server.executeOperation(
      {
        query: UPDATE_EVENT,
        variables: { id: event.id, input: { title: 'Updated Title', location: 'Terminal 1' } },
      },
      ctx(ALICE),
    );
    if (res.body.kind !== 'single') return;
    expect(res.body.singleResult.errors).toBeUndefined();
    const data = res.body.singleResult.data?.updateCommunityEvent as {
      title: string;
      location: string;
    };
    expect(data.title).toBe('Updated Title');
    expect(data.location).toBe('Terminal 1');
  });

  it('admin can update any event', async () => {
    const { alice, bob } = await seedUsers();
    const community = await seedCommunity(alice.id);
    await addMember(community.id, bob.id, 'admin');
    const event = await seedEvent(community.id, alice.id);

    const res = await server.executeOperation(
      { query: UPDATE_EVENT, variables: { id: event.id, input: { title: 'Admin Update' } } },
      ctx(BOB),
    );
    if (res.body.kind !== 'single') return;
    expect(res.body.singleResult.errors).toBeUndefined();
  });

  it('non-organizer member cannot update event', async () => {
    const { alice, bob } = await seedUsers();
    const community = await seedCommunity(alice.id);
    await addMember(community.id, bob.id, 'member');
    const event = await seedEvent(community.id, alice.id);

    const res = await server.executeOperation(
      { query: UPDATE_EVENT, variables: { id: event.id, input: { title: 'Hijack' } } },
      ctx(BOB),
    );
    if (res.body.kind !== 'single') return;
    expect(res.body.singleResult.errors).toBeDefined();
    expect(res.body.singleResult.errors![0].extensions?.code).toBe('FORBIDDEN');
  });
});

describe('deleteCommunityEvent mutation', () => {
  it('organizer can delete their event', async () => {
    const { alice } = await seedUsers();
    const community = await seedCommunity(alice.id);
    const event = await seedEvent(community.id, alice.id);

    const res = await server.executeOperation(
      { query: DELETE_EVENT, variables: { id: event.id } },
      ctx(ALICE),
    );
    if (res.body.kind !== 'single') return;
    expect(res.body.singleResult.errors).toBeUndefined();
    expect(res.body.singleResult.data?.deleteCommunityEvent).toBe(true);

    const found = await prisma.communityEvent.findUnique({ where: { id: event.id } });
    expect(found).toBeNull();
  });

  it('admin can delete any event', async () => {
    const { alice, bob } = await seedUsers();
    const community = await seedCommunity(alice.id);
    await addMember(community.id, bob.id, 'admin');
    const event = await seedEvent(community.id, alice.id);

    const res = await server.executeOperation(
      { query: DELETE_EVENT, variables: { id: event.id } },
      ctx(BOB),
    );
    if (res.body.kind !== 'single') return;
    expect(res.body.singleResult.errors).toBeUndefined();
  });

  it('regular member cannot delete event', async () => {
    const { alice, bob } = await seedUsers();
    const community = await seedCommunity(alice.id);
    await addMember(community.id, bob.id, 'member');
    const event = await seedEvent(community.id, alice.id);

    const res = await server.executeOperation(
      { query: DELETE_EVENT, variables: { id: event.id } },
      ctx(BOB),
    );
    if (res.body.kind !== 'single') return;
    expect(res.body.singleResult.errors).toBeDefined();
    expect(res.body.singleResult.errors![0].extensions?.code).toBe('FORBIDDEN');
  });

  it('returns error for non-existent event', async () => {
    const { alice } = await seedUsers();
    await seedCommunity(alice.id);

    const res = await server.executeOperation(
      { query: DELETE_EVENT, variables: { id: '00000000-0000-0000-0000-000000000000' } },
      ctx(ALICE),
    );
    if (res.body.kind !== 'single') return;
    expect(res.body.singleResult.errors).toBeDefined();
    expect(res.body.singleResult.errors![0].extensions?.code).toBe('NOT_FOUND');
  });
});

describe('rsvpEvent mutation', () => {
  it('member can RSVP going', async () => {
    const { alice, bob } = await seedUsers();
    const community = await seedCommunity(alice.id);
    await addMember(community.id, bob.id, 'member');
    const event = await seedEvent(community.id, alice.id);

    const res = await server.executeOperation(
      { query: RSVP, variables: { eventId: event.id, status: 'going' } },
      ctx(BOB),
    );
    if (res.body.kind !== 'single') return;
    expect(res.body.singleResult.errors).toBeUndefined();
    const data = res.body.singleResult.data?.rsvpEvent as { status: string; eventId: string };
    expect(data.status).toBe('going');
    expect(data.eventId).toBe(event.id);
  });

  it('member can RSVP maybe', async () => {
    const { alice, bob } = await seedUsers();
    const community = await seedCommunity(alice.id);
    await addMember(community.id, bob.id, 'member');
    const event = await seedEvent(community.id, alice.id);

    const res = await server.executeOperation(
      { query: RSVP, variables: { eventId: event.id, status: 'maybe' } },
      ctx(BOB),
    );
    if (res.body.kind !== 'single') return;
    expect(res.body.singleResult.errors).toBeUndefined();
    const data = res.body.singleResult.data?.rsvpEvent as { status: string };
    expect(data.status).toBe('maybe');
  });

  it('RSVP is idempotent (upsert)', async () => {
    const { alice, bob } = await seedUsers();
    const community = await seedCommunity(alice.id);
    await addMember(community.id, bob.id, 'member');
    const event = await seedEvent(community.id, alice.id);

    await server.executeOperation(
      { query: RSVP, variables: { eventId: event.id, status: 'going' } },
      ctx(BOB),
    );
    const res = await server.executeOperation(
      { query: RSVP, variables: { eventId: event.id, status: 'maybe' } },
      ctx(BOB),
    );
    if (res.body.kind !== 'single') return;
    expect(res.body.singleResult.errors).toBeUndefined();
    const data = res.body.singleResult.data?.rsvpEvent as { status: string };
    expect(data.status).toBe('maybe');
    const count = await prisma.eventAttendee.count({ where: { eventId: event.id } });
    expect(count).toBe(1);
  });

  it('non-member cannot RSVP', async () => {
    const { alice } = await seedUsers();
    const community = await seedCommunity(alice.id);
    const event = await seedEvent(community.id, alice.id);

    const res = await server.executeOperation(
      { query: RSVP, variables: { eventId: event.id, status: 'going' } },
      ctx(BOB),
    );
    if (res.body.kind !== 'single') return;
    expect(res.body.singleResult.errors).toBeDefined();
    expect(res.body.singleResult.errors![0].extensions?.code).toBe('FORBIDDEN');
  });

  it('rejects invalid status', async () => {
    const { alice, bob } = await seedUsers();
    const community = await seedCommunity(alice.id);
    await addMember(community.id, bob.id, 'member');
    const event = await seedEvent(community.id, alice.id);

    const res = await server.executeOperation(
      { query: RSVP, variables: { eventId: event.id, status: 'absolutely' } },
      ctx(BOB),
    );
    if (res.body.kind !== 'single') return;
    expect(res.body.singleResult.errors).toBeDefined();
    expect(res.body.singleResult.errors![0].extensions?.code).toBe('BAD_USER_INPUT');
  });

  it('enforces capacity limit', async () => {
    const { alice, bob, charlie } = await seedUsers();
    const community = await seedCommunity(alice.id);
    await addMember(community.id, bob.id, 'member');
    await addMember(community.id, charlie.id, 'member');
    const event = await seedEvent(community.id, alice.id, { maxAttendees: 1 });

    // Bob RSVPs going (fills capacity)
    await server.executeOperation(
      { query: RSVP, variables: { eventId: event.id, status: 'going' } },
      ctx(BOB),
    );

    // Charlie tries to RSVP going → should fail
    const res = await server.executeOperation(
      { query: RSVP, variables: { eventId: event.id, status: 'going' } },
      ctx(CHARLIE),
    );
    if (res.body.kind !== 'single') return;
    expect(res.body.singleResult.errors).toBeDefined();
    expect(res.body.singleResult.errors![0].message).toMatch(/capacity/);
  });

  it('can RSVP maybe even when at capacity', async () => {
    const { alice, bob, charlie } = await seedUsers();
    const community = await seedCommunity(alice.id);
    await addMember(community.id, bob.id, 'member');
    await addMember(community.id, charlie.id, 'member');
    const event = await seedEvent(community.id, alice.id, { maxAttendees: 1 });

    await server.executeOperation(
      { query: RSVP, variables: { eventId: event.id, status: 'going' } },
      ctx(BOB),
    );

    // Charlie RSVPs maybe — capacity only applies to 'going'
    const res = await server.executeOperation(
      { query: RSVP, variables: { eventId: event.id, status: 'maybe' } },
      ctx(CHARLIE),
    );
    if (res.body.kind !== 'single') return;
    expect(res.body.singleResult.errors).toBeUndefined();
    const data = res.body.singleResult.data?.rsvpEvent as { status: string };
    expect(data.status).toBe('maybe');
  });
});

describe('cancelRsvp mutation', () => {
  it('member can cancel RSVP', async () => {
    const { alice, bob } = await seedUsers();
    const community = await seedCommunity(alice.id);
    await addMember(community.id, bob.id, 'member');
    const event = await seedEvent(community.id, alice.id);

    await server.executeOperation(
      { query: RSVP, variables: { eventId: event.id, status: 'going' } },
      ctx(BOB),
    );

    const res = await server.executeOperation(
      { query: CANCEL_RSVP, variables: { eventId: event.id } },
      ctx(BOB),
    );
    if (res.body.kind !== 'single') return;
    expect(res.body.singleResult.errors).toBeUndefined();
    expect(res.body.singleResult.data?.cancelRsvp).toBe(true);

    const count = await prisma.eventAttendee.count({ where: { eventId: event.id } });
    expect(count).toBe(0);
  });

  it('cancelRsvp is idempotent (returns false if no RSVP exists)', async () => {
    const { alice, bob } = await seedUsers();
    const community = await seedCommunity(alice.id);
    await addMember(community.id, bob.id, 'member');
    const event = await seedEvent(community.id, alice.id);

    const res = await server.executeOperation(
      { query: CANCEL_RSVP, variables: { eventId: event.id } },
      ctx(BOB),
    );
    if (res.body.kind !== 'single') return;
    expect(res.body.singleResult.errors).toBeUndefined();
    expect(res.body.singleResult.data?.cancelRsvp).toBe(false);
  });
});

describe('field resolvers', () => {
  it('attendeeCount reflects going RSVPs only', async () => {
    const { alice, bob, charlie } = await seedUsers();
    const community = await seedCommunity(alice.id);
    await addMember(community.id, bob.id, 'member');
    await addMember(community.id, charlie.id, 'member');
    const event = await seedEvent(community.id, alice.id);

    await server.executeOperation(
      { query: RSVP, variables: { eventId: event.id, status: 'going' } },
      ctx(BOB),
    );
    await server.executeOperation(
      { query: RSVP, variables: { eventId: event.id, status: 'maybe' } },
      ctx(CHARLIE),
    );

    const res = await server.executeOperation(
      { query: GET_EVENT, variables: { id: event.id } },
      ctx(),
    );
    if (res.body.kind !== 'single') return;
    const data = res.body.singleResult.data?.communityEvent as { attendeeCount: number };
    expect(data.attendeeCount).toBe(1); // only bob is 'going'
  });

  it('myRsvp returns null for unauthenticated user', async () => {
    const { alice } = await seedUsers();
    const community = await seedCommunity(alice.id);
    const event = await seedEvent(community.id, alice.id);

    const res = await server.executeOperation(
      { query: GET_EVENT, variables: { id: event.id } },
      ctx(),
    );
    if (res.body.kind !== 'single') return;
    const data = res.body.singleResult.data?.communityEvent as { myRsvp: null };
    expect(data.myRsvp).toBeNull();
  });

  it('myRsvp returns the current user RSVP', async () => {
    const { alice, bob } = await seedUsers();
    const community = await seedCommunity(alice.id);
    await addMember(community.id, bob.id, 'member');
    const event = await seedEvent(community.id, alice.id);

    await server.executeOperation(
      { query: RSVP, variables: { eventId: event.id, status: 'going' } },
      ctx(BOB),
    );

    const res = await server.executeOperation(
      { query: GET_EVENT, variables: { id: event.id } },
      ctx(BOB),
    );
    if (res.body.kind !== 'single') return;
    const data = res.body.singleResult.data?.communityEvent as { myRsvp: { status: string } };
    expect(data.myRsvp).not.toBeNull();
    expect(data.myRsvp.status).toBe('going');
  });

  it('isFull is false when no maxAttendees', async () => {
    const { alice } = await seedUsers();
    const community = await seedCommunity(alice.id);
    const event = await seedEvent(community.id, alice.id);

    const res = await server.executeOperation(
      { query: GET_EVENT, variables: { id: event.id } },
      ctx(),
    );
    if (res.body.kind !== 'single') return;
    const data = res.body.singleResult.data?.communityEvent as { isFull: boolean };
    expect(data.isFull).toBe(false);
  });

  it('isFull is true when at capacity', async () => {
    const { alice, bob } = await seedUsers();
    const community = await seedCommunity(alice.id);
    await addMember(community.id, bob.id, 'member');
    const event = await seedEvent(community.id, alice.id, { maxAttendees: 1 });

    await server.executeOperation(
      { query: RSVP, variables: { eventId: event.id, status: 'going' } },
      ctx(BOB),
    );

    const res = await server.executeOperation(
      { query: GET_EVENT, variables: { id: event.id } },
      ctx(),
    );
    if (res.body.kind !== 'single') return;
    const data = res.body.singleResult.data?.communityEvent as { isFull: boolean };
    expect(data.isFull).toBe(true);
  });
});
