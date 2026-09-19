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

const AUTH_USER = { sub: 'sub-location-tester', email: 'loc@test.com', username: 'loctester' };

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

const PHOTOS_IN_BOUNDS = `
  query PhotosInBounds($swLat: Float!, $swLng: Float!, $neLat: Float!, $neLng: Float!, $first: Int) {
    photosInBounds(swLat: $swLat, swLng: $swLng, neLat: $neLat, neLng: $neLng, first: $first) {
      id
      latitude
      longitude
      thumbnailUrl
      caption
    }
  }
`;

const PHOTOS_NEARBY = `
  query PhotosNearby($latitude: Float!, $longitude: Float!, $radiusMeters: Float, $first: Int) {
    photosNearby(latitude: $latitude, longitude: $longitude, radiusMeters: $radiusMeters, first: $first) {
      id
      latitude
      longitude
      thumbnailUrl
      caption
    }
  }
`;

const CREATE_SPOTTING_LOCATION = `
  mutation CreateSpottingLocation($input: CreateSpottingLocationInput!) {
    createSpottingLocation(input: $input) {
      id
      name
      description
      accessNotes
      latitude
      longitude
      createdBy { id username }
    }
  }
`;

const DELETE_SPOTTING_LOCATION = `
  mutation DeleteSpottingLocation($id: ID!) {
    deleteSpottingLocation(id: $id)
  }
`;

// ─── Helpers ────────────────────────────────────────────────────────────────

async function createUser(
  overrides: Partial<{ email: string; username: string; cognitoSub: string }> = {},
) {
  return prisma.user.create({
    data: {
      email: overrides.email ?? 'loc@test.com',
      username: overrides.username ?? 'loctester',
      cognitoSub: overrides.cognitoSub ?? AUTH_USER.sub,
    },
  });
}

async function createAirport() {
  return prisma.airport.create({
    data: {
      icaoCode: 'KSEA',
      iataCode: 'SEA',
      name: 'Seattle-Tacoma International Airport',
      city: 'Seattle',
      country: 'US',
      latitude: 47.4502,
      longitude: -122.3088,
    },
  });
}

async function createPhotoWithLocation(
  userId: string,
  lat: number,
  lng: number,
  privacyMode = 'exact',
) {
  const photo = await prisma.photo.create({
    data: {
      userId,
      originalUrl: 'http://localhost:4566/test.jpg',
      mimeType: 'image/jpeg',
      moderationStatus: 'approved',
      caption: `Photo at ${lat},${lng}`,
    },
  });

  const displayLat = privacyMode === 'hidden' ? 0 : lat;
  const displayLng = privacyMode === 'hidden' ? 0 : lng;

  await prisma.photoLocation.create({
    data: {
      photoId: photo.id,
      rawLatitude: lat,
      rawLongitude: lng,
      displayLatitude: displayLat,
      displayLongitude: displayLng,
      privacyMode: privacyMode as 'exact' | 'approximate' | 'hidden',
    },
  });

  return photo;
}

// ─── Tests ──────────────────────────────────────────────────────────────────

describe('photosInBounds', () => {
  it('returns photos within the bounding box', async () => {
    const user = await createUser();
    await createPhotoWithLocation(user.id, 47.45, -122.31);
    await createPhotoWithLocation(user.id, 47.46, -122.3);
    // Outside bounds
    await createPhotoWithLocation(user.id, 33.94, -118.41);

    const res = await server.executeOperation(
      {
        query: PHOTOS_IN_BOUNDS,
        variables: { swLat: 47.0, swLng: -123.0, neLat: 48.0, neLng: -122.0 },
      },
      ctx(),
    );

    const data = (res.body as any).singleResult.data;
    expect(data.photosInBounds).toHaveLength(2);
  });

  it('excludes photos with hidden privacy', async () => {
    const user = await createUser();
    await createPhotoWithLocation(user.id, 47.45, -122.31, 'exact');
    await createPhotoWithLocation(user.id, 47.46, -122.3, 'hidden');

    const res = await server.executeOperation(
      {
        query: PHOTOS_IN_BOUNDS,
        variables: { swLat: 47.0, swLng: -123.0, neLat: 48.0, neLng: -122.0 },
      },
      ctx(),
    );

    const data = (res.body as any).singleResult.data;
    expect(data.photosInBounds).toHaveLength(1);
  });

  it('respects the first limit', async () => {
    const user = await createUser();
    await createPhotoWithLocation(user.id, 47.45, -122.31);
    await createPhotoWithLocation(user.id, 47.46, -122.3);
    await createPhotoWithLocation(user.id, 47.47, -122.29);

    const res = await server.executeOperation(
      {
        query: PHOTOS_IN_BOUNDS,
        variables: { swLat: 47.0, swLng: -123.0, neLat: 48.0, neLng: -122.0, first: 2 },
      },
      ctx(),
    );

    const data = (res.body as any).singleResult.data;
    expect(data.photosInBounds).toHaveLength(2);
  });

  it('returns photos linked to an airport via airportCode (no PhotoLocation row)', async () => {
    const user = await createUser();
    const airport = await createAirport(); // KSEA at 47.4502, -122.3088

    // Photo with airportCode set but NO PhotoLocation row (legacy / imported)
    await prisma.photo.create({
      data: {
        userId: user.id,
        originalUrl: 'http://localhost:4566/airport-only.jpg',
        mimeType: 'image/jpeg',
        moderationStatus: 'approved',
        airportCode: airport.icaoCode,
        caption: 'Airport-linked, no PhotoLocation',
      },
    });

    // Sanity: also create one out-of-bounds (London) airport-linked photo
    const london = await prisma.airport.create({
      data: {
        icaoCode: 'EGLL',
        iataCode: 'LHR',
        name: 'Heathrow',
        city: 'London',
        country: 'GB',
        latitude: 51.4775,
        longitude: -0.4614,
      },
    });
    await prisma.photo.create({
      data: {
        userId: user.id,
        originalUrl: 'http://localhost:4566/london.jpg',
        mimeType: 'image/jpeg',
        moderationStatus: 'approved',
        airportCode: london.icaoCode,
        caption: 'Out of bounds',
      },
    });

    const res = await server.executeOperation(
      {
        query: PHOTOS_IN_BOUNDS,
        variables: { swLat: 47.0, swLng: -123.0, neLat: 48.0, neLng: -122.0 },
      },
      ctx(),
    );

    const data = (res.body as any).singleResult.data;
    expect(data.photosInBounds).toHaveLength(1);
    expect(data.photosInBounds[0].caption).toBe('Airport-linked, no PhotoLocation');
    // Coordinates fall back to the airport itself
    expect(data.photosInBounds[0].latitude).toBeCloseTo(airport.latitude, 4);
    expect(data.photosInBounds[0].longitude).toBeCloseTo(airport.longitude, 4);
  });

  it('does not duplicate photos that have both airportCode and PhotoLocation', async () => {
    const user = await createUser();
    const airport = await createAirport();

    // Photo with both airport_code AND a PhotoLocation row (normal upload path)
    const photo = await prisma.photo.create({
      data: {
        userId: user.id,
        originalUrl: 'http://localhost:4566/dual.jpg',
        mimeType: 'image/jpeg',
        moderationStatus: 'approved',
        airportCode: airport.icaoCode,
        caption: 'Has both location and airport',
      },
    });
    await prisma.photoLocation.create({
      data: {
        photoId: photo.id,
        rawLatitude: airport.latitude,
        rawLongitude: airport.longitude,
        displayLatitude: airport.latitude,
        displayLongitude: airport.longitude,
        airportId: airport.id,
      },
    });

    const res = await server.executeOperation(
      {
        query: PHOTOS_IN_BOUNDS,
        variables: { swLat: 47.0, swLng: -123.0, neLat: 48.0, neLng: -122.0 },
      },
      ctx(),
    );

    const data = (res.body as any).singleResult.data;
    expect(data.photosInBounds).toHaveLength(1);
  });
});

describe('photosNearby', () => {
  it('returns photos within the radius', async () => {
    const user = await createUser();
    // ~200m from center point
    await createPhotoWithLocation(user.id, 47.4502, -122.3088);
    // ~50km away — outside default 5km radius
    await createPhotoWithLocation(user.id, 47.9, -122.3);

    const res = await server.executeOperation(
      {
        query: PHOTOS_NEARBY,
        variables: { latitude: 47.4502, longitude: -122.3088, radiusMeters: 5000 },
      },
      ctx(),
    );

    const data = (res.body as any).singleResult.data;
    expect(data.photosNearby).toHaveLength(1);
    expect(data.photosNearby[0].latitude).toBeCloseTo(47.4502);
  });
});

describe('createSpottingLocation', () => {
  it('creates a spotting location', async () => {
    await createUser();
    const airport = await createAirport();

    const res = await server.executeOperation(
      {
        query: CREATE_SPOTTING_LOCATION,
        variables: {
          input: {
            name: 'Angle Lake',
            description: 'Great views of 16R arrivals',
            accessNotes: 'Free parking',
            latitude: 47.44,
            longitude: -122.31,
            airportId: airport.id,
          },
        },
      },
      ctx(AUTH_USER),
    );

    const data = (res.body as any).singleResult.data;
    expect(data.createSpottingLocation.name).toBe('Angle Lake');
    expect(data.createSpottingLocation.description).toBe('Great views of 16R arrivals');
    expect(data.createSpottingLocation.latitude).toBe(47.44);
    expect(data.createSpottingLocation.createdBy.username).toBe('loctester');
  });

  it('rejects invalid airport ID', async () => {
    await createUser();

    const res = await server.executeOperation(
      {
        query: CREATE_SPOTTING_LOCATION,
        variables: {
          input: {
            name: 'Nowhere',
            latitude: 47.44,
            longitude: -122.31,
            airportId: '00000000-0000-0000-0000-000000000000',
          },
        },
      },
      ctx(AUTH_USER),
    );

    const errors = (res.body as any).singleResult.errors;
    expect(errors[0].extensions.code).toBe('BAD_USER_INPUT');
  });

  it('requires authentication', async () => {
    const airport = await createAirport();

    const res = await server.executeOperation(
      {
        query: CREATE_SPOTTING_LOCATION,
        variables: {
          input: { name: 'Test', latitude: 47.44, longitude: -122.31, airportId: airport.id },
        },
      },
      ctx(null),
    );

    const errors = (res.body as any).singleResult.errors;
    expect(errors).toBeDefined();
    expect(errors.length).toBeGreaterThan(0);
  });
});

describe('deleteSpottingLocation', () => {
  it('deletes own spotting location', async () => {
    const airport = await createAirport();
    const dbUser = await createUser();
    const spot = await prisma.spottingLocation.create({
      data: {
        name: 'Test Spot',
        latitude: 47.44,
        longitude: -122.31,
        airportId: airport.id,
        createdById: dbUser.id,
      },
    });

    const res = await server.executeOperation(
      { query: DELETE_SPOTTING_LOCATION, variables: { id: spot.id } },
      ctx(AUTH_USER),
    );

    const data = (res.body as any).singleResult.data;
    expect(data.deleteSpottingLocation).toBe(true);

    // Verify it's deleted
    const found = await prisma.spottingLocation.findUnique({ where: { id: spot.id } });
    expect(found).toBeNull();
  });

  it("rejects deleting another user's spotting location", async () => {
    const owner = await createUser({
      email: 'owner@test.com',
      username: 'owner',
      cognitoSub: 'sub-owner',
    });
    await createUser();
    const airport = await createAirport();
    const spot = await prisma.spottingLocation.create({
      data: {
        name: 'Owner Spot',
        latitude: 47.44,
        longitude: -122.31,
        airportId: airport.id,
        createdById: owner.id,
      },
    });

    const res = await server.executeOperation(
      { query: DELETE_SPOTTING_LOCATION, variables: { id: spot.id } },
      ctx(AUTH_USER),
    );

    const errors = (res.body as any).singleResult.errors;
    expect(errors[0].extensions.code).toBe('FORBIDDEN');
  });
});
