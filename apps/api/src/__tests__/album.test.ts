import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';

import type { Context } from '../context.js';

import {
  cleanDatabase,
  createTestContext,
  prisma,
  setupTestServer,
  teardownTestServer,
} from './testHelpers.js';

// ─── Setup ──────────────────────────────────────────────────────────────────

let server: Awaited<ReturnType<typeof setupTestServer>>;

function ctx(user: Context['user'] = null): Context {
  return createTestContext(user);
}

const AUTH_USER = { sub: 'sub-album-owner', email: 'owner@test.com', username: 'owner' };
const OTHER_USER = { sub: 'sub-album-other', email: 'other@test.com', username: 'other' };

beforeAll(async () => {
  server = await setupTestServer();
});

afterAll(async () => {
  await teardownTestServer(server);
});

beforeEach(cleanDatabase);

// ─── Helpers ────────────────────────────────────────────────────────────────

async function createUser(
  overrides: Partial<{ cognitoSub: string; username: string; email: string }> = {},
) {
  return prisma.user.create({
    data: {
      cognitoSub: overrides.cognitoSub ?? 'sub-album-owner',
      username: overrides.username ?? 'owner',
      email: overrides.email ?? 'owner@test.com',
    },
  });
}

async function createAlbumInDb(
  userId: string,
  overrides: Partial<{ title: string; description: string; isPublic: boolean }> = {},
) {
  return prisma.album.create({
    data: {
      userId,
      title: overrides.title ?? 'Test Album',
      description: overrides.description ?? 'A test album',
      isPublic: overrides.isPublic ?? true,
    },
  });
}

async function createPhotoInDb(userId: string, albumId?: string) {
  return prisma.photo.create({
    data: {
      userId,
      albumId: albumId ?? null,
      originalUrl: 'http://localhost:4566/test.jpg',
      mimeType: 'image/jpeg',
      moderationStatus: 'approved',
    },
  });
}

// ─── GraphQL ────────────────────────────────────────────────────────────────

const CREATE_ALBUM = `
  mutation CreateAlbum($input: CreateAlbumInput!) {
    createAlbum(input: $input) {
      id title description isPublic photoCount
      user { username }
      createdAt updatedAt
    }
  }
`;

const UPDATE_ALBUM = `
  mutation UpdateAlbum($id: ID!, $input: UpdateAlbumInput!) {
    updateAlbum(id: $id, input: $input) {
      id title description isPublic
      coverPhoto { id }
    }
  }
`;

const DELETE_ALBUM = `
  mutation DeleteAlbum($id: ID!) { deleteAlbum(id: $id) }
`;

const ADD_PHOTOS = `
  mutation AddPhotos($albumId: ID!, $photoIds: [ID!]!) {
    addPhotosToAlbum(albumId: $albumId, photoIds: $photoIds) {
      id photoCount
    }
  }
`;

const REMOVE_PHOTOS = `
  mutation RemovePhotos($albumId: ID!, $photoIds: [ID!]!) {
    removePhotosFromAlbum(albumId: $albumId, photoIds: $photoIds) {
      id photoCount
    }
  }
`;

const GET_ALBUM = `
  query Album($id: ID!) {
    album(id: $id) {
      id title description isPublic photoCount
      user { username }
      createdAt updatedAt
    }
  }
`;

const GET_ALBUMS = `
  query Albums($userId: ID, $first: Int) {
    albums(userId: $userId, first: $first) {
      edges { cursor node { id title photoCount isPublic } }
      pageInfo { hasNextPage endCursor }
      totalCount
    }
  }
`;

// ─── createAlbum ────────────────────────────────────────────────────────────

describe('createAlbum', () => {
  it('creates an album', async () => {
    await createUser();
    const res = await server.executeOperation(
      {
        query: CREATE_ALBUM,
        variables: { input: { title: 'My Album', description: 'Cool photos' } },
      },
      { contextValue: ctx(AUTH_USER) },
    );
    const data = (res.body as any).singleResult.data;
    expect(data.createAlbum.title).toBe('My Album');
    expect(data.createAlbum.description).toBe('Cool photos');
    expect(data.createAlbum.isPublic).toBe(true);
    expect(data.createAlbum.photoCount).toBe(0);
    expect(data.createAlbum.user.username).toBe('owner');
  });

  it('creates a private album', async () => {
    await createUser();
    const res = await server.executeOperation(
      { query: CREATE_ALBUM, variables: { input: { title: 'Secret', isPublic: false } } },
      { contextValue: ctx(AUTH_USER) },
    );
    const data = (res.body as any).singleResult.data;
    expect(data.createAlbum.isPublic).toBe(false);
  });

  it('rejects empty title', async () => {
    await createUser();
    const res = await server.executeOperation(
      { query: CREATE_ALBUM, variables: { input: { title: '   ' } } },
      { contextValue: ctx(AUTH_USER) },
    );
    const errors = (res.body as any).singleResult.errors;
    expect(errors).toBeDefined();
    expect(errors[0].extensions.code).toBe('BAD_USER_INPUT');
  });

  it('rejects title over 100 characters', async () => {
    await createUser();
    const res = await server.executeOperation(
      { query: CREATE_ALBUM, variables: { input: { title: 'x'.repeat(101) } } },
      { contextValue: ctx(AUTH_USER) },
    );
    const errors = (res.body as any).singleResult.errors;
    expect(errors).toBeDefined();
    expect(errors[0].extensions.code).toBe('BAD_USER_INPUT');
  });

  it('requires authentication', async () => {
    const res = await server.executeOperation(
      { query: CREATE_ALBUM, variables: { input: { title: 'Fail' } } },
      { contextValue: ctx() },
    );
    const errors = (res.body as any).singleResult.errors;
    expect(errors[0].extensions.code).toBe('UNAUTHENTICATED');
  });
});

// ─── updateAlbum ────────────────────────────────────────────────────────────

describe('updateAlbum', () => {
  it('updates title and description', async () => {
    const user = await createUser();
    const album = await createAlbumInDb(user.id);

    const res = await server.executeOperation(
      {
        query: UPDATE_ALBUM,
        variables: { id: album.id, input: { title: 'Renamed', description: 'Updated desc' } },
      },
      { contextValue: ctx(AUTH_USER) },
    );
    const data = (res.body as any).singleResult.data;
    expect(data.updateAlbum.title).toBe('Renamed');
    expect(data.updateAlbum.description).toBe('Updated desc');
  });

  it('toggles isPublic', async () => {
    const user = await createUser();
    const album = await createAlbumInDb(user.id);

    const res = await server.executeOperation(
      { query: UPDATE_ALBUM, variables: { id: album.id, input: { isPublic: false } } },
      { contextValue: ctx(AUTH_USER) },
    );
    const data = (res.body as any).singleResult.data;
    expect(data.updateAlbum.isPublic).toBe(false);
  });

  it('sets cover photo from album', async () => {
    const user = await createUser();
    const album = await createAlbumInDb(user.id);
    const photo = await createPhotoInDb(user.id, album.id);

    const res = await server.executeOperation(
      { query: UPDATE_ALBUM, variables: { id: album.id, input: { coverPhotoId: photo.id } } },
      { contextValue: ctx(AUTH_USER) },
    );
    const data = (res.body as any).singleResult.data;
    expect(data.updateAlbum.coverPhoto.id).toBe(photo.id);
  });

  it('rejects cover photo not in album', async () => {
    const user = await createUser();
    const album = await createAlbumInDb(user.id);
    const photo = await createPhotoInDb(user.id); // not in album

    const res = await server.executeOperation(
      { query: UPDATE_ALBUM, variables: { id: album.id, input: { coverPhotoId: photo.id } } },
      { contextValue: ctx(AUTH_USER) },
    );
    const errors = (res.body as any).singleResult.errors;
    expect(errors[0].extensions.code).toBe('BAD_USER_INPUT');
  });

  it('only owner can update', async () => {
    const user = await createUser();
    await createUser({ cognitoSub: 'sub-album-other', username: 'other', email: 'other@test.com' });
    const album = await createAlbumInDb(user.id);

    const res = await server.executeOperation(
      { query: UPDATE_ALBUM, variables: { id: album.id, input: { title: 'Hacked' } } },
      { contextValue: ctx(OTHER_USER) },
    );
    const errors = (res.body as any).singleResult.errors;
    expect(errors[0].extensions.code).toBe('FORBIDDEN');
  });
});

// ─── deleteAlbum ────────────────────────────────────────────────────────────

describe('deleteAlbum', () => {
  it('deletes album and unlinks photos', async () => {
    const user = await createUser();
    const album = await createAlbumInDb(user.id);
    const photo = await createPhotoInDb(user.id, album.id);

    const res = await server.executeOperation(
      { query: DELETE_ALBUM, variables: { id: album.id } },
      { contextValue: ctx(AUTH_USER) },
    );
    expect((res.body as any).singleResult.data.deleteAlbum).toBe(true);

    // Album gone
    const deleted = await prisma.album.findUnique({ where: { id: album.id } });
    expect(deleted).toBeNull();

    // Photo still exists but albumId is null
    const unlinked = await prisma.photo.findUnique({ where: { id: photo.id } });
    expect(unlinked).not.toBeNull();
    expect(unlinked!.albumId).toBeNull();
  });

  it('only owner can delete', async () => {
    const user = await createUser();
    await createUser({ cognitoSub: 'sub-album-other', username: 'other', email: 'other@test.com' });
    const album = await createAlbumInDb(user.id);

    const res = await server.executeOperation(
      { query: DELETE_ALBUM, variables: { id: album.id } },
      { contextValue: ctx(OTHER_USER) },
    );
    const errors = (res.body as any).singleResult.errors;
    expect(errors[0].extensions.code).toBe('FORBIDDEN');
  });

  it('returns error for non-existent album', async () => {
    await createUser();
    const res = await server.executeOperation(
      { query: DELETE_ALBUM, variables: { id: '00000000-0000-0000-0000-000000000000' } },
      { contextValue: ctx(AUTH_USER) },
    );
    const errors = (res.body as any).singleResult.errors;
    expect(errors[0].extensions.code).toBe('NOT_FOUND');
  });
});

// ─── addPhotosToAlbum ───────────────────────────────────────────────────────

describe('addPhotosToAlbum', () => {
  it('adds photos to album', async () => {
    const user = await createUser();
    const album = await createAlbumInDb(user.id);
    const p1 = await createPhotoInDb(user.id);
    const p2 = await createPhotoInDb(user.id);

    const res = await server.executeOperation(
      { query: ADD_PHOTOS, variables: { albumId: album.id, photoIds: [p1.id, p2.id] } },
      { contextValue: ctx(AUTH_USER) },
    );
    const data = (res.body as any).singleResult.data;
    expect(data.addPhotosToAlbum.photoCount).toBe(2);
  });

  it("rejects adding other user's photos", async () => {
    const user = await createUser();
    const otherUser = await createUser({
      cognitoSub: 'sub-album-other',
      username: 'other',
      email: 'other@test.com',
    });
    const album = await createAlbumInDb(user.id);
    const otherPhoto = await createPhotoInDb(otherUser.id);

    const res = await server.executeOperation(
      { query: ADD_PHOTOS, variables: { albumId: album.id, photoIds: [otherPhoto.id] } },
      { contextValue: ctx(AUTH_USER) },
    );
    const errors = (res.body as any).singleResult.errors;
    expect(errors[0].extensions.code).toBe('FORBIDDEN');
  });

  it('only album owner can add photos', async () => {
    const user = await createUser();
    await createUser({ cognitoSub: 'sub-album-other', username: 'other', email: 'other@test.com' });
    const album = await createAlbumInDb(user.id);

    const res = await server.executeOperation(
      { query: ADD_PHOTOS, variables: { albumId: album.id, photoIds: [] } },
      { contextValue: ctx(OTHER_USER) },
    );
    const errors = (res.body as any).singleResult.errors;
    expect(errors[0].extensions.code).toBe('FORBIDDEN');
  });
});

// ─── removePhotosFromAlbum ──────────────────────────────────────────────────

describe('removePhotosFromAlbum', () => {
  it('removes photos from album', async () => {
    const user = await createUser();
    const album = await createAlbumInDb(user.id);
    const photo = await createPhotoInDb(user.id, album.id);

    const res = await server.executeOperation(
      { query: REMOVE_PHOTOS, variables: { albumId: album.id, photoIds: [photo.id] } },
      { contextValue: ctx(AUTH_USER) },
    );
    const data = (res.body as any).singleResult.data;
    expect(data.removePhotosFromAlbum.photoCount).toBe(0);
  });

  it('only owner can remove photos', async () => {
    const user = await createUser();
    await createUser({ cognitoSub: 'sub-album-other', username: 'other', email: 'other@test.com' });
    const album = await createAlbumInDb(user.id);

    const res = await server.executeOperation(
      { query: REMOVE_PHOTOS, variables: { albumId: album.id, photoIds: [] } },
      { contextValue: ctx(OTHER_USER) },
    );
    const errors = (res.body as any).singleResult.errors;
    expect(errors[0].extensions.code).toBe('FORBIDDEN');
  });
});

// ─── album query ────────────────────────────────────────────────────────────

describe('album query', () => {
  it('returns album with all fields', async () => {
    const user = await createUser();
    const album = await createAlbumInDb(user.id, {
      title: 'KSEA Shots',
      description: 'Seattle spotting',
    });
    await createPhotoInDb(user.id, album.id);

    const res = await server.executeOperation(
      { query: GET_ALBUM, variables: { id: album.id } },
      { contextValue: ctx() },
    );
    const data = (res.body as any).singleResult.data;
    expect(data.album.title).toBe('KSEA Shots');
    expect(data.album.description).toBe('Seattle spotting');
    expect(data.album.isPublic).toBe(true);
    expect(data.album.photoCount).toBe(1);
    expect(data.album.user.username).toBe('owner');
  });

  it('returns null for non-existent album', async () => {
    const res = await server.executeOperation(
      { query: GET_ALBUM, variables: { id: '00000000-0000-0000-0000-000000000000' } },
      { contextValue: ctx() },
    );
    const data = (res.body as any).singleResult.data;
    expect(data.album).toBeNull();
  });
});

// ─── albums query ───────────────────────────────────────────────────────────

describe('albums query', () => {
  it("returns user's public albums to non-owner", async () => {
    const user = await createUser();
    await createAlbumInDb(user.id, { title: 'Public' });
    await createAlbumInDb(user.id, { title: 'Private', isPublic: false });

    const res = await server.executeOperation(
      { query: GET_ALBUMS, variables: { userId: user.id } },
      { contextValue: ctx() },
    );
    const data = (res.body as any).singleResult.data;
    expect(data.albums.totalCount).toBe(1);
    expect(data.albums.edges[0].node.title).toBe('Public');
  });

  it('returns all albums to owner (including private)', async () => {
    const user = await createUser();
    await createAlbumInDb(user.id, { title: 'Public' });
    await createAlbumInDb(user.id, { title: 'Private', isPublic: false });

    const res = await server.executeOperation(
      { query: GET_ALBUMS, variables: { userId: user.id } },
      { contextValue: ctx(AUTH_USER) },
    );
    const data = (res.body as any).singleResult.data;
    expect(data.albums.totalCount).toBe(2);
  });

  it("defaults to authenticated user's albums when no userId", async () => {
    const user = await createUser();
    await createAlbumInDb(user.id, { title: 'Mine' });

    const res = await server.executeOperation(
      { query: GET_ALBUMS },
      { contextValue: ctx(AUTH_USER) },
    );
    const data = (res.body as any).singleResult.data;
    expect(data.albums.totalCount).toBe(1);
    expect(data.albums.edges[0].node.title).toBe('Mine');
  });
});
