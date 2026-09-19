import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';

import type { Context } from '../context.js';

import {
  cleanDatabase,
  createTestContext,
  createTestUser,
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

const CREATE_CATEGORY = `
  mutation CreateForumCategory($communityId: ID, $name: String!, $description: String, $slug: String) {
    createForumCategory(communityId: $communityId, name: $name, description: $description, slug: $slug) {
      id name slug description position threadCount
    }
  }
`;

const UPDATE_CATEGORY = `
  mutation UpdateForumCategory($id: ID!, $name: String, $description: String, $position: Int) {
    updateForumCategory(id: $id, name: $name, description: $description, position: $position) {
      id name description position
    }
  }
`;

const DELETE_CATEGORY = `
  mutation DeleteForumCategory($id: ID!) { deleteForumCategory(id: $id) }
`;

const GET_CATEGORIES = `
  query ForumCategories($communityId: ID!) {
    forumCategories(communityId: $communityId) {
      id name slug position threadCount
    }
  }
`;

const CREATE_THREAD = `
  mutation CreateForumThread($categoryId: ID!, $title: String!, $body: String!) {
    createForumThread(categoryId: $categoryId, title: $title, body: $body) {
      id title isPinned isLocked postCount
      author { username }
      firstPost { body }
    }
  }
`;

const DELETE_THREAD = `
  mutation DeleteForumThread($id: ID!) { deleteForumThread(id: $id) }
`;

const PIN_THREAD = `
  mutation PinForumThread($id: ID!, $pinned: Boolean!) {
    pinForumThread(id: $id, pinned: $pinned) { id isPinned }
  }
`;

const LOCK_THREAD = `
  mutation LockForumThread($id: ID!, $locked: Boolean!) {
    lockForumThread(id: $id, locked: $locked) { id isLocked }
  }
`;

const GET_THREADS = `
  query ForumThreads($categoryId: ID!, $first: Int, $after: String) {
    forumThreads(categoryId: $categoryId, first: $first, after: $after) {
      edges { cursor node { id title isPinned postCount author { username } } }
      pageInfo { hasNextPage endCursor }
      totalCount
    }
  }
`;

const CREATE_POST = `
  mutation CreateForumPost($threadId: ID!, $body: String!, $parentPostId: ID) {
    createForumPost(threadId: $threadId, body: $body, parentPostId: $parentPostId) {
      id body isDeleted
      author { username }
      replies { id body }
    }
  }
`;

const UPDATE_POST = `
  mutation UpdateForumPost($id: ID!, $body: String!) {
    updateForumPost(id: $id, body: $body) { id body }
  }
`;

const DELETE_POST = `
  mutation DeleteForumPost($id: ID!) { deleteForumPost(id: $id) }
`;

const GET_POSTS = `
  query ForumPosts($threadId: ID!, $first: Int, $after: String) {
    forumPosts(threadId: $threadId, first: $first, after: $after) {
      edges { cursor node { id body isDeleted author { username } replies { id body } } }
      pageInfo { hasNextPage endCursor }
      totalCount
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

async function createCommunityWithMembers() {
  const { alice, bob, charlie } = await createUsers();

  const community = await prisma.community.create({
    data: {
      name: 'LAX Spotters',
      slug: 'lax-spotters',
      visibility: 'public',
      ownerId: alice.id,
      members: {
        create: [
          { userId: alice.id, role: 'owner', status: 'active' },
          { userId: bob.id, role: 'member', status: 'active' },
        ],
      },
    },
  });

  return { community, alice, bob, charlie };
}

async function createCategory(communityId: string) {
  const res = await server.executeOperation(
    {
      query: CREATE_CATEGORY,
      variables: { communityId, name: 'General Discussion', description: 'Talk about anything' },
    },
    ctx(ALICE),
  );
  return (res.body as any).singleResult.data.createForumCategory;
}

async function createThread(categoryId: string, user = ALICE) {
  const res = await server.executeOperation(
    {
      query: CREATE_THREAD,
      variables: {
        categoryId,
        title: 'Best spotting spots at LAX',
        body: 'I love the In-N-Out rooftop!',
      },
    },
    ctx(user),
  );
  return (res.body as any).singleResult.data.createForumThread;
}

// ─── Tests ──────────────────────────────────────────────────────────────────

describe('createForumCategory', () => {
  it('creates a category as owner', async () => {
    const { community } = await createCommunityWithMembers();

    const res = await server.executeOperation(
      {
        query: CREATE_CATEGORY,
        variables: {
          communityId: community.id,
          name: 'General Discussion',
          description: 'Talk about anything',
        },
      },
      ctx(ALICE),
    );
    const result = (res.body as any).singleResult;

    expect(result.errors).toBeUndefined();
    expect(result.data.createForumCategory.name).toBe('General Discussion');
    expect(result.data.createForumCategory.slug).toBe('general-discussion');
    expect(result.data.createForumCategory.position).toBe(0);
    expect(result.data.createForumCategory.threadCount).toBe(0);
  });

  it('auto-increments position for subsequent categories', async () => {
    const { community } = await createCommunityWithMembers();
    await createCategory(community.id);

    const res = await server.executeOperation(
      { query: CREATE_CATEGORY, variables: { communityId: community.id, name: 'Trip Reports' } },
      ctx(ALICE),
    );
    const result = (res.body as any).singleResult;
    expect(result.data.createForumCategory.position).toBe(1);
  });

  it('accepts custom slug', async () => {
    const { community } = await createCommunityWithMembers();

    const res = await server.executeOperation(
      {
        query: CREATE_CATEGORY,
        variables: { communityId: community.id, name: 'Q&A', slug: 'qanda' },
      },
      ctx(ALICE),
    );
    const result = (res.body as any).singleResult;
    expect(result.data.createForumCategory.slug).toBe('qanda');
  });

  it('rejects duplicate slug within community', async () => {
    const { community } = await createCommunityWithMembers();
    await createCategory(community.id);

    const res = await server.executeOperation(
      {
        query: CREATE_CATEGORY,
        variables: {
          communityId: community.id,
          name: 'Another General',
          slug: 'general-discussion',
        },
      },
      ctx(ALICE),
    );
    const result = (res.body as any).singleResult;
    expect(result.errors[0].extensions.code).toBe('BAD_USER_INPUT');
  });

  it('rejects non-admin member', async () => {
    const { community } = await createCommunityWithMembers();

    const res = await server.executeOperation(
      { query: CREATE_CATEGORY, variables: { communityId: community.id, name: 'Forbidden' } },
      ctx(BOB),
    );
    const result = (res.body as any).singleResult;
    expect(result.errors[0].extensions.code).toBe('FORBIDDEN');
  });

  it('rejects unauthenticated user', async () => {
    const { community } = await createCommunityWithMembers();

    const res = await server.executeOperation(
      { query: CREATE_CATEGORY, variables: { communityId: community.id, name: 'No Auth' } },
      ctx(null),
    );
    const result = (res.body as any).singleResult;
    expect(result.errors[0].extensions.code).toBe('UNAUTHENTICATED');
  });
});

describe('forumCategories', () => {
  it('returns empty list when no categories', async () => {
    const { community } = await createCommunityWithMembers();

    const res = await server.executeOperation(
      { query: GET_CATEGORIES, variables: { communityId: community.id } },
      ctx(null),
    );
    const result = (res.body as any).singleResult;
    expect(result.errors).toBeUndefined();
    expect(result.data.forumCategories).toEqual([]);
  });

  it('returns categories ordered by position', async () => {
    const { community } = await createCommunityWithMembers();
    await createCategory(community.id);

    await server.executeOperation(
      { query: CREATE_CATEGORY, variables: { communityId: community.id, name: 'Trip Reports' } },
      ctx(ALICE),
    );

    const res = await server.executeOperation(
      { query: GET_CATEGORIES, variables: { communityId: community.id } },
      ctx(null),
    );
    const cats = (res.body as any).singleResult.data.forumCategories;
    expect(cats).toHaveLength(2);
    expect(cats[0].name).toBe('General Discussion');
    expect(cats[1].name).toBe('Trip Reports');
  });
});

describe('updateForumCategory', () => {
  it('updates category name as owner', async () => {
    const { community } = await createCommunityWithMembers();
    const cat = await createCategory(community.id);

    const res = await server.executeOperation(
      { query: UPDATE_CATEGORY, variables: { id: cat.id, name: 'Updated Name' } },
      ctx(ALICE),
    );
    const result = (res.body as any).singleResult;
    expect(result.errors).toBeUndefined();
    expect(result.data.updateForumCategory.name).toBe('Updated Name');
  });

  it('rejects update from regular member', async () => {
    const { community } = await createCommunityWithMembers();
    const cat = await createCategory(community.id);

    const res = await server.executeOperation(
      { query: UPDATE_CATEGORY, variables: { id: cat.id, name: 'Hack' } },
      ctx(BOB),
    );
    const result = (res.body as any).singleResult;
    expect(result.errors[0].extensions.code).toBe('FORBIDDEN');
  });
});

describe('deleteForumCategory', () => {
  it('deletes category as owner', async () => {
    const { community } = await createCommunityWithMembers();
    const cat = await createCategory(community.id);

    const res = await server.executeOperation(
      { query: DELETE_CATEGORY, variables: { id: cat.id } },
      ctx(ALICE),
    );
    expect((res.body as any).singleResult.data.deleteForumCategory).toBe(true);

    const count = await prisma.forumCategory.count({ where: { id: cat.id } });
    expect(count).toBe(0);
  });

  it('rejects deletion from regular member', async () => {
    const { community } = await createCommunityWithMembers();
    const cat = await createCategory(community.id);

    const res = await server.executeOperation(
      { query: DELETE_CATEGORY, variables: { id: cat.id } },
      ctx(BOB),
    );
    expect((res.body as any).singleResult.errors[0].extensions.code).toBe('FORBIDDEN');
  });
});

describe('Global forum categories', () => {
  it('admin can create a global category (no communityId)', async () => {
    await createTestUser({
      email: 'admin@test.com',
      username: 'admin',
      cognitoSub: 'admin-sub',
    });
    await prisma.user.update({
      where: { cognitoSub: 'admin-sub' },
      data: { role: 'superuser' },
    });

    const res = await server.executeOperation(
      { query: CREATE_CATEGORY, variables: { name: 'General Discussion' } },
      {
        contextValue: createTestContext({
          sub: 'admin-sub',
          email: 'admin@test.com',
          username: 'admin',
        }),
      },
    );

    const data = (res.body as any).singleResult;
    expect(data.errors).toBeUndefined();
    expect(data.data.createForumCategory.name).toBe('General Discussion');
    expect(data.data.createForumCategory.slug).toBe('general-discussion');
  });

  it('non-admin cannot create a global category', async () => {
    await createTestUser();

    const res = await server.executeOperation(
      { query: CREATE_CATEGORY, variables: { name: 'Hack Category' } },
      {
        contextValue: createTestContext({
          sub: 'test-sub-1',
          email: 'test@example.com',
          username: 'testuser',
        }),
      },
    );

    const errors = (res.body as any).singleResult.errors;
    expect(errors).toBeDefined();
    expect(errors[0].extensions.code).toBe('FORBIDDEN');
  });
});

describe('createForumThread', () => {
  it('creates thread with first post as member', async () => {
    const { community } = await createCommunityWithMembers();
    const cat = await createCategory(community.id);

    const res = await server.executeOperation(
      {
        query: CREATE_THREAD,
        variables: { categoryId: cat.id, title: 'Best spots at LAX', body: 'Love the roof deck!' },
      },
      ctx(BOB),
    );
    const result = (res.body as any).singleResult;

    expect(result.errors).toBeUndefined();
    expect(result.data.createForumThread.title).toBe('Best spots at LAX');
    expect(result.data.createForumThread.postCount).toBe(1);
    expect(result.data.createForumThread.isPinned).toBe(false);
    expect(result.data.createForumThread.isLocked).toBe(false);
    expect(result.data.createForumThread.author.username).toBe('bob');
    expect(result.data.createForumThread.firstPost.body).toBe('Love the roof deck!');
  });

  it('rejects non-member', async () => {
    const { community } = await createCommunityWithMembers();
    const cat = await createCategory(community.id);

    const res = await server.executeOperation(
      {
        query: CREATE_THREAD,
        variables: { categoryId: cat.id, title: 'Hi', body: 'Trying to post' },
      },
      ctx(CHARLIE),
    );
    expect((res.body as any).singleResult.errors[0].extensions.code).toBe('FORBIDDEN');
  });

  it('rejects unauthenticated user', async () => {
    const { community } = await createCommunityWithMembers();
    const cat = await createCategory(community.id);

    const res = await server.executeOperation(
      { query: CREATE_THREAD, variables: { categoryId: cat.id, title: 'Hi', body: 'test' } },
      ctx(null),
    );
    expect((res.body as any).singleResult.errors[0].extensions.code).toBe('UNAUTHENTICATED');
  });

  it('rejects short title', async () => {
    const { community } = await createCommunityWithMembers();
    const cat = await createCategory(community.id);

    const res = await server.executeOperation(
      { query: CREATE_THREAD, variables: { categoryId: cat.id, title: 'Hi', body: 'test body' } },
      ctx(ALICE),
    );
    expect((res.body as any).singleResult.errors[0].extensions.code).toBe('BAD_USER_INPUT');
  });
});

describe('forumThreads', () => {
  it('returns threads with pinned first', async () => {
    const { community } = await createCommunityWithMembers();
    const cat = await createCategory(community.id);

    const t1 = await createThread(cat.id, BOB);
    const t2 = await createThread(cat.id, ALICE);

    // Pin t2
    await server.executeOperation(
      { query: PIN_THREAD, variables: { id: t2.id, pinned: true } },
      ctx(ALICE),
    );

    const res = await server.executeOperation(
      { query: GET_THREADS, variables: { categoryId: cat.id } },
      ctx(null),
    );
    const threads = (res.body as any).singleResult.data.forumThreads.edges;
    expect(threads[0].node.isPinned).toBe(true);
    expect(threads[0].node.id).toBe(t2.id);
    expect(threads[1].node.id).toBe(t1.id);
  });

  it('returns totalCount', async () => {
    const { community } = await createCommunityWithMembers();
    const cat = await createCategory(community.id);
    await createThread(cat.id);
    await createThread(cat.id);

    const res = await server.executeOperation(
      { query: GET_THREADS, variables: { categoryId: cat.id } },
      ctx(null),
    );
    expect((res.body as any).singleResult.data.forumThreads.totalCount).toBe(2);
  });
});

describe('pinForumThread', () => {
  it('allows moderator to pin a thread', async () => {
    const { community, charlie } = await createCommunityWithMembers();
    await prisma.communityMember.create({
      data: { communityId: community.id, userId: charlie.id, role: 'moderator', status: 'active' },
    });

    const cat = await createCategory(community.id);
    const thread = await createThread(cat.id);

    const res = await server.executeOperation(
      { query: PIN_THREAD, variables: { id: thread.id, pinned: true } },
      ctx(CHARLIE),
    );
    expect((res.body as any).singleResult.data.pinForumThread.isPinned).toBe(true);
  });

  it('rejects regular member pinning', async () => {
    const { community } = await createCommunityWithMembers();
    const cat = await createCategory(community.id);
    const thread = await createThread(cat.id);

    const res = await server.executeOperation(
      { query: PIN_THREAD, variables: { id: thread.id, pinned: true } },
      ctx(BOB),
    );
    expect((res.body as any).singleResult.errors[0].extensions.code).toBe('FORBIDDEN');
  });
});

describe('lockForumThread', () => {
  it('allows owner to lock a thread', async () => {
    const { community } = await createCommunityWithMembers();
    const cat = await createCategory(community.id);
    const thread = await createThread(cat.id);

    const res = await server.executeOperation(
      { query: LOCK_THREAD, variables: { id: thread.id, locked: true } },
      ctx(ALICE),
    );
    expect((res.body as any).singleResult.data.lockForumThread.isLocked).toBe(true);
  });

  it('rejects regular member locking', async () => {
    const { community } = await createCommunityWithMembers();
    const cat = await createCategory(community.id);
    const thread = await createThread(cat.id);

    const res = await server.executeOperation(
      { query: LOCK_THREAD, variables: { id: thread.id, locked: true } },
      ctx(BOB),
    );
    expect((res.body as any).singleResult.errors[0].extensions.code).toBe('FORBIDDEN');
  });
});

describe('createForumPost', () => {
  it('creates a reply in a thread', async () => {
    const { community } = await createCommunityWithMembers();
    const cat = await createCategory(community.id);
    const thread = await createThread(cat.id);

    const res = await server.executeOperation(
      { query: CREATE_POST, variables: { threadId: thread.id, body: 'Great tip!' } },
      ctx(BOB),
    );
    const result = (res.body as any).singleResult;

    expect(result.errors).toBeUndefined();
    expect(result.data.createForumPost.body).toBe('Great tip!');
    expect(result.data.createForumPost.author.username).toBe('bob');
    expect(result.data.createForumPost.isDeleted).toBe(false);

    // Check postCount incremented
    const updatedThread = await prisma.forumThread.findUnique({ where: { id: thread.id } });
    expect(updatedThread?.postCount).toBe(2);
  });

  it('creates a nested reply (parentPostId)', async () => {
    const { community } = await createCommunityWithMembers();
    const cat = await createCategory(community.id);
    const thread = await createThread(cat.id);
    const firstPost = await prisma.forumPost.findFirst({ where: { threadId: thread.id } });

    const res = await server.executeOperation(
      {
        query: CREATE_POST,
        variables: { threadId: thread.id, body: 'Replying to you!', parentPostId: firstPost!.id },
      },
      ctx(BOB),
    );
    const result = (res.body as any).singleResult;
    expect(result.errors).toBeUndefined();
    expect(result.data.createForumPost.body).toBe('Replying to you!');
  });

  it('rejects posting in a locked thread', async () => {
    const { community } = await createCommunityWithMembers();
    const cat = await createCategory(community.id);
    const thread = await createThread(cat.id);

    await server.executeOperation(
      { query: LOCK_THREAD, variables: { id: thread.id, locked: true } },
      ctx(ALICE),
    );

    const res = await server.executeOperation(
      { query: CREATE_POST, variables: { threadId: thread.id, body: 'Trying to post' } },
      ctx(BOB),
    );
    expect((res.body as any).singleResult.errors[0].extensions.code).toBe('FORBIDDEN');
  });

  it('rejects non-member posting', async () => {
    const { community } = await createCommunityWithMembers();
    const cat = await createCategory(community.id);
    const thread = await createThread(cat.id);

    const res = await server.executeOperation(
      { query: CREATE_POST, variables: { threadId: thread.id, body: 'Intruder!' } },
      ctx(CHARLIE),
    );
    expect((res.body as any).singleResult.errors[0].extensions.code).toBe('FORBIDDEN');
  });
});

describe('forumPosts', () => {
  it('returns top-level posts with replies', async () => {
    const { community } = await createCommunityWithMembers();
    const cat = await createCategory(community.id);
    const thread = await createThread(cat.id);

    const firstPost = await prisma.forumPost.findFirst({ where: { threadId: thread.id } });

    // Add a top-level reply
    await server.executeOperation(
      { query: CREATE_POST, variables: { threadId: thread.id, body: 'A reply' } },
      ctx(BOB),
    );

    // Add a nested reply to the first post
    await server.executeOperation(
      {
        query: CREATE_POST,
        variables: { threadId: thread.id, body: 'Nested!', parentPostId: firstPost!.id },
      },
      ctx(BOB),
    );

    const res = await server.executeOperation(
      { query: GET_POSTS, variables: { threadId: thread.id } },
      ctx(null),
    );
    const result = (res.body as any).singleResult;

    expect(result.errors).toBeUndefined();
    // Only 2 top-level posts (original + "A reply"), nested not in top-level
    expect(result.data.forumPosts.edges).toHaveLength(2);
    expect(result.data.forumPosts.totalCount).toBe(2);
    // First post has 1 reply
    expect(result.data.forumPosts.edges[0].node.replies).toHaveLength(1);
    expect(result.data.forumPosts.edges[0].node.replies[0].body).toBe('Nested!');
  });
});

describe('updateForumPost', () => {
  it('allows author to edit post within 24h', async () => {
    const { community } = await createCommunityWithMembers();
    const cat = await createCategory(community.id);
    const thread = await createThread(cat.id);

    const postRes = await server.executeOperation(
      { query: CREATE_POST, variables: { threadId: thread.id, body: 'Original body' } },
      ctx(BOB),
    );
    const post = (postRes.body as any).singleResult.data.createForumPost;

    const res = await server.executeOperation(
      { query: UPDATE_POST, variables: { id: post.id, body: 'Edited body' } },
      ctx(BOB),
    );
    expect((res.body as any).singleResult.data.updateForumPost.body).toBe('Edited body');
  });

  it('rejects edit by non-author', async () => {
    const { community } = await createCommunityWithMembers();
    const cat = await createCategory(community.id);
    const thread = await createThread(cat.id);

    const postRes = await server.executeOperation(
      { query: CREATE_POST, variables: { threadId: thread.id, body: 'Original' } },
      ctx(BOB),
    );
    const post = (postRes.body as any).singleResult.data.createForumPost;

    const res = await server.executeOperation(
      { query: UPDATE_POST, variables: { id: post.id, body: 'Hijacked' } },
      ctx(ALICE),
    );
    expect((res.body as any).singleResult.errors[0].extensions.code).toBe('FORBIDDEN');
  });
});

describe('deleteForumPost', () => {
  it('soft-deletes a post as author', async () => {
    const { community } = await createCommunityWithMembers();
    const cat = await createCategory(community.id);
    const thread = await createThread(cat.id);

    const postRes = await server.executeOperation(
      { query: CREATE_POST, variables: { threadId: thread.id, body: 'Delete me' } },
      ctx(BOB),
    );
    const post = (postRes.body as any).singleResult.data.createForumPost;

    const res = await server.executeOperation(
      { query: DELETE_POST, variables: { id: post.id } },
      ctx(BOB),
    );
    expect((res.body as any).singleResult.data.deleteForumPost).toBe(true);

    const dbPost = await prisma.forumPost.findUnique({ where: { id: post.id } });
    expect(dbPost?.isDeleted).toBe(true);
    expect(dbPost?.body).toBe('[deleted]');
  });

  it('soft-deletes a post as moderator', async () => {
    const { community, charlie } = await createCommunityWithMembers();
    await prisma.communityMember.create({
      data: { communityId: community.id, userId: charlie.id, role: 'moderator', status: 'active' },
    });

    const cat = await createCategory(community.id);
    const thread = await createThread(cat.id);

    const postRes = await server.executeOperation(
      { query: CREATE_POST, variables: { threadId: thread.id, body: 'Flagged content' } },
      ctx(BOB),
    );
    const post = (postRes.body as any).singleResult.data.createForumPost;

    const res = await server.executeOperation(
      { query: DELETE_POST, variables: { id: post.id } },
      ctx(CHARLIE),
    );
    expect((res.body as any).singleResult.data.deleteForumPost).toBe(true);
  });

  it('rejects deletion by non-author non-moderator', async () => {
    const { community } = await createCommunityWithMembers();
    const cat = await createCategory(community.id);
    const thread = await createThread(cat.id);

    const firstPost = await prisma.forumPost.findFirst({ where: { threadId: thread.id } });

    // Bob tries to delete Alice's post (the opening post)
    const res = await server.executeOperation(
      { query: DELETE_POST, variables: { id: firstPost!.id } },
      ctx(BOB),
    );
    expect((res.body as any).singleResult.errors[0].extensions.code).toBe('FORBIDDEN');
  });
});

describe('deleteForumThread', () => {
  it('allows author to delete thread', async () => {
    const { community } = await createCommunityWithMembers();
    const cat = await createCategory(community.id);
    const thread = await createThread(cat.id, BOB);

    const res = await server.executeOperation(
      { query: DELETE_THREAD, variables: { id: thread.id } },
      ctx(BOB),
    );
    expect((res.body as any).singleResult.data.deleteForumThread).toBe(true);
  });

  it('allows owner to delete any thread', async () => {
    const { community } = await createCommunityWithMembers();
    const cat = await createCategory(community.id);
    const thread = await createThread(cat.id, BOB);

    const res = await server.executeOperation(
      { query: DELETE_THREAD, variables: { id: thread.id } },
      ctx(ALICE),
    );
    expect((res.body as any).singleResult.data.deleteForumThread).toBe(true);
  });

  it('rejects deletion by unrelated member', async () => {
    const { community } = await createCommunityWithMembers();
    // Charlie is not a member
    const cat = await createCategory(community.id);
    const thread = await createThread(cat.id, BOB);

    const res = await server.executeOperation(
      { query: DELETE_THREAD, variables: { id: thread.id } },
      ctx(CHARLIE),
    );
    expect((res.body as any).singleResult.errors[0].extensions.code).toBe('FORBIDDEN');
  });
});

// ─── Date Serialization (regression) ────────────────────────────────────────
// GraphQL defaults to coercing Date objects via Date.prototype.toString(),
// which produces strings like "Wed Jun 05 2026 ..." that some browsers
// (notably Safari) fail to parse, surfacing as "Invalid Date" in the UI.
// Forum field resolvers explicitly call .toISOString() to avoid this. These
// tests pin that contract.
describe('forum date serialization', () => {
  const ISO_8601 = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

  function expectIso(value: unknown) {
    expect(typeof value).toBe('string');
    expect(value as string).toMatch(ISO_8601);
    expect(Number.isNaN(new Date(value as string).getTime())).toBe(false);
  }

  it('serializes ForumCategory createdAt/updatedAt as ISO 8601 strings', async () => {
    const { community } = await createCommunityWithMembers();
    await createCategory(community.id);

    const QUERY = `
      query ($communityId: ID!) {
        forumCategories(communityId: $communityId) { id createdAt updatedAt }
      }
    `;
    const res = await server.executeOperation(
      { query: QUERY, variables: { communityId: community.id } },
      ctx(null),
    );
    const cats = (res.body as any).singleResult.data.forumCategories;
    expect(cats).toHaveLength(1);
    expectIso(cats[0].createdAt);
    expectIso(cats[0].updatedAt);
  });

  it('serializes ForumThread createdAt/updatedAt/lastPostAt as ISO 8601 strings', async () => {
    const { community } = await createCommunityWithMembers();
    const cat = await createCategory(community.id);
    const thread = await createThread(cat.id);

    const QUERY = `
      query ($id: ID!) {
        forumThread(id: $id) { id createdAt updatedAt lastPostAt }
      }
    `;
    const res = await server.executeOperation(
      { query: QUERY, variables: { id: thread.id } },
      ctx(null),
    );
    const t = (res.body as any).singleResult.data.forumThread;
    expectIso(t.createdAt);
    expectIso(t.updatedAt);
    expectIso(t.lastPostAt);
  });

  it('serializes ForumPost createdAt/updatedAt as ISO 8601 strings', async () => {
    const { community } = await createCommunityWithMembers();
    const cat = await createCategory(community.id);
    const thread = await createThread(cat.id);

    const QUERY = `
      query ($threadId: ID!) {
        forumPosts(threadId: $threadId, first: 10) {
          edges { node { id createdAt updatedAt } }
        }
      }
    `;
    const res = await server.executeOperation(
      { query: QUERY, variables: { threadId: thread.id } },
      ctx(null),
    );
    const edges = (res.body as any).singleResult.data.forumPosts.edges;
    expect(edges.length).toBeGreaterThan(0);
    for (const { node } of edges) {
      expectIso(node.createdAt);
      expectIso(node.updatedAt);
    }
  });
});
