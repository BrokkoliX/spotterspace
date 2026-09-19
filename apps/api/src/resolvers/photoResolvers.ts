import {
  validateUpload,
  USER_TIER_LIMITS,
  validateWatermarkConfig,
  WatermarkPosition,
  type WatermarkConfig,
} from '@spotterspace/shared';
import { GraphQLError } from 'graphql';

import { requireAuth, requireRole } from '../auth/requireAuth.js';
import type { Context } from '../context.js';
import { generateVariants, getSharp } from '../services/imageProcessing.js';
import { getObjectUrl, getPresignedUploadUrl } from '../services/s3.js';
import { getDbUser } from '../utils/resolverHelpers.js';
import { encodeCursor, buildPaginationArgs } from '../utils/resolverHelpers.js';
import { validateStringLength, validateArrayLength } from '../utils/validation.js';

import { checkAndAwardBadges } from './badgeResolvers.js';
import { createNotification } from './notificationResolvers.js';

// ─── Privacy Helpers ────────────────────────────────────────────────────────

/**
 * Apply privacy mode to coordinates.
 * - exact: use raw coordinates as-is
 * - approximate: jitter by ~500m random offset
 * - hidden: set display coords to 0 (won't be returned by field resolver)
 */
function applyPrivacy(lat: number, lng: number, mode: string) {
  switch (mode) {
    case 'approximate': {
      const jitterLat = (Math.random() - 0.5) * 0.01;
      const jitterLng = (Math.random() - 0.5) * 0.01;
      return { displayLat: lat + jitterLat, displayLng: lng + jitterLng };
    }
    case 'hidden':
      return { displayLat: 0, displayLng: 0 };
    case 'exact':
    default:
      return { displayLat: lat, displayLng: lng };
  }
}

// ─── Types ──────────────────────────────────────────────────────────────────

export type PhotoSortBy =
  | 'recent'
  | 'popular_day'
  | 'popular_week'
  | 'popular_month'
  | 'popular_all'
  | 'random';

export interface PhotosArgs {
  first?: number;
  after?: string;
  page?: number;
  userId?: string;
  albumId?: string;
  airportCode?: string;
  tags?: string[];
  manufacturer?: string;
  family?: string;
  variant?: string;
  airline?: string;
  photographer?: string;
  sortBy?: PhotoSortBy;
  kind?: 'AIRCRAFT' | 'COMMUNITY';
  communityCategory?: 'SCENERY' | 'EVENT' | 'HANGAR' | 'AIRPORT' | 'PEOPLE' | 'OTHER';
  /**
   * Restrict to photos whose album belongs to one of the given communities.
   * Powers community-scoped feed views (e.g. a 'photos from communities you
   * joined' tab on the home page). Photos with no album, or with an album
   * that has no communityId, are excluded when this is set.
   */
  communityIds?: string[];
  /**
   * Filter to photos that have been awarded a badge with this slug
   * (via UserBadge.awardedPhotoId). Used by the "Admin's Choice" feed
   * tab on the home page (slug = 'AChoice').
   */
  awardSlug?: string;
}

export interface CreatePhotoInput {
  s3Key: string;
  mimeType: string;
  fileSizeBytes: number;
  caption?: string;
  airline?: string;
  airportCode?: string;
  takenAt?: string;
  tags?: string[];
  latitude?: number;
  longitude?: number;
  locationPrivacy?: string;
  aircraftId?: string;
  gearBody?: string;
  gearLens?: string;
  exifData?: unknown;
  photoCategoryId?: string;
  aircraftSpecificCategoryId?: string;
  operatorIcao?: string;
  operatorType?: string;
  msn?: string;
  manufacturingDate?: string;
  locationType?: string;
  airportIcao?: string;
  license?: string;
  watermarkEnabled?: boolean;
  watermarkConfig?: WatermarkConfig;
  kind?: 'AIRCRAFT' | 'COMMUNITY';
  communityCategory?: 'SCENERY' | 'EVENT' | 'HANGAR' | 'AIRPORT' | 'PEOPLE' | 'OTHER';
}

export interface UpdatePhotoInput {
  caption?: string;
  airline?: string;
  airportCode?: string;
  takenAt?: string;
  tags?: string[];
  latitude?: number;
  longitude?: number;
  locationPrivacy?: string;
  aircraftId?: string;
  gearBody?: string;
  gearLens?: string;
  exifData?: unknown;
  photoCategoryId?: string;
  aircraftSpecificCategoryId?: string;
  operatorIcao?: string;
  operatorType?: string;
  msn?: string;
  manufacturingDate?: string;
  locationType?: string;
  airportIcao?: string;
  kind?: 'AIRCRAFT' | 'COMMUNITY';
  communityCategory?: 'SCENERY' | 'EVENT' | 'HANGAR' | 'AIRPORT' | 'PEOPLE' | 'OTHER';
}

export interface PhotoParent {
  id: string;
  userId: string;
  albumId?: string | null;
  aircraftId?: string | null;
  photographerId?: string | null;
  photographerName?: string | null;
  gearBody?: string | null;
  gearLens?: string | null;
  takenAt?: Date | null;
  exifData?: unknown | null;
  photoCategoryId?: string | null;
  aircraftSpecificCategoryId?: string | null;
  operatorIcao?: string | null;
  operatorType?: string | null;
  msn?: string | null;
  manufacturingDate?: string | null;
  kind?: 'AIRCRAFT' | 'COMMUNITY';
  communityCategory?: 'SCENERY' | 'EVENT' | 'HANGAR' | 'AIRPORT' | 'PEOPLE' | 'OTHER' | null;
  isDeleted?: boolean;
  moderationStatus?: 'pending' | 'approved' | 'rejected' | 'review';
  moderationLabels?: unknown | null;
  watermarkEnabled?: boolean;
  watermarkPosition?: string | null;
  watermarkSize?: number | null;
  watermarkOpacity?: number | null;
}

// ─── Privacy Helpers ────────────────────────────────────────────────────────

/**
 * Returns a Prisma filter to exclude soft-deleted records for non-privileged users.
 * Admin, moderator, and superuser see all content.
 */
async function deletedFilter(ctx: Context): Promise<Record<string, unknown>> {
  try {
    const authUser = requireAuth(ctx);
    const dbUser = await ctx.prisma.user.findUnique({
      where: { cognitoSub: authUser.sub },
      select: { role: true },
    });
    if (dbUser && ['admin', 'moderator', 'superuser'].includes(dbUser.role)) {
      return {};
    }
  } catch {
    // Not authenticated
  }
  return { isDeleted: false };
}

// ─── Query Resolvers ────────────────────────────────────────────────────────

export const photoQueryResolvers = {
  photo: async (_parent: unknown, args: { id: string }, ctx: Context) => {
    const filter = await deletedFilter(ctx);
    return ctx.prisma.photo.findFirst({
      where: { id: args.id, ...filter },
      include: {
        user: true,
        variants: true,
        tags: true,
        aircraft: {
          include: { manufacturer: true, family: true, variant: true, airlineRef: true },
        },
        location: { include: { airport: true, spottingLocation: true } },
        photoCategory: true,
        aircraftSpecificCategory: true,
      },
    });
  },

  photos: async (_parent: unknown, args: PhotosArgs, ctx: Context) => {
    const { skip, take, cursorWhere } = buildPaginationArgs({
      first: args.first,
      after: args.after,
      page: args.page,
    });
    const deletedFilter_ = await deletedFilter(ctx);

    // Build filter conditions
    const where: Record<string, unknown> = {
      moderationStatus: 'approved',
      ...deletedFilter_,
    };

    if (cursorWhere) {
      Object.assign(where, cursorWhere);
    }
    if (args.userId) {
      where.userId = args.userId;
    }
    if (args.albumId) {
      where.albumId = args.albumId;
    }
    if (args.airportCode) {
      where.airportCode = { equals: args.airportCode, mode: 'insensitive' };
    }
    if (args.tags && args.tags.length > 0) {
      where.tags = {
        some: { tag: { in: args.tags } },
      };
    }
    if (args.airline) {
      where.airline = { contains: args.airline, mode: 'insensitive' };
    }
    if (args.photographer) {
      where.photographerName = { contains: args.photographer, mode: 'insensitive' };
    }
    if (args.kind) {
      where.kind = args.kind;
    }
    if (args.communityCategory) {
      where.communityCategory = args.communityCategory;
    }

    // Community filter — restrict to photos whose album belongs to one
    // of the given communities. Powers community-scoped feed views on
    // the home page. Empty array means "no communities", which would
    // return zero rows; we treat that the same as "filter not applied"
    // to avoid surprising the caller, since the typical signed-in user
    // with no community memberships should still see the empty state
    // surfaced by the UI rather than a hard zero from the API.
    if (args.communityIds && args.communityIds.length > 0) {
      where.album = { is: { communityId: { in: args.communityIds } } };
    }

    // Exclude community photos from the unscoped "general" feed.
    // Community photos belong to a community context (an album inside
    // a community) and surfacing them in the global home/explore/airport
    // feeds dilutes the aircraft-spotting focus those surfaces are
    // meant to have. We only apply this default when the caller has
    // not scoped the query to a specific user, album, community, or
    // photo kind — those scoped views (profile galleries, album
    // pages, community feeds, explicit COMMUNITY tab) should still
    // return community photos as expected.
    const isScopedQuery =
      Boolean(args.userId) ||
      Boolean(args.albumId) ||
      Boolean(args.kind) ||
      (args.communityIds !== undefined && args.communityIds.length > 0);
    if (!isScopedQuery) {
      where.kind = 'AIRCRAFT';
    }

    // Filter to photos that have been awarded a specific badge — used by
    // the "Admin's Choice" feed tab on the home page. We use `some` with
    // a slug match on the related BadgeDefinition. Each `awardedPhotoId`
    // on UserBadge is what links a badge instance back to a photo.
    if (args.awardSlug) {
      where.awardedBadges = {
        some: { badgeDefinition: { slug: args.awardSlug, isActive: true } },
      };
    }

    // Aircraft hierarchy filters — all three can be applied simultaneously
    const aircraftFilter: Record<string, unknown> = {};
    if (args.manufacturer) {
      aircraftFilter.manufacturer = { name: { contains: args.manufacturer, mode: 'insensitive' } };
    }
    if (args.family) {
      aircraftFilter.family = { name: { contains: args.family, mode: 'insensitive' } };
    }
    if (args.variant) {
      aircraftFilter.variant = { name: { contains: args.variant, mode: 'insensitive' } };
    }
    if (Object.keys(aircraftFilter).length > 0) {
      where.aircraft = aircraftFilter;
    }

    // Determine sort order
    const isRandom = args.sortBy === 'random';
    let orderBy: Record<string, unknown> = { createdAt: 'desc' };
    if (args.sortBy === 'popular_all') {
      orderBy = { likeCount: 'desc' };
    } else if (args.sortBy === 'popular_day') {
      const cutoff = new Date(Date.now() - 86_400_000);
      where.createdAt = { ...((where.createdAt as object) || {}), gte: cutoff };
      orderBy = { likeCount: 'desc' };
    } else if (args.sortBy === 'popular_week') {
      const cutoff = new Date(Date.now() - 7 * 86_400_000);
      where.createdAt = { ...((where.createdAt as object) || {}), gte: cutoff };
      orderBy = { likeCount: 'desc' };
    } else if (args.sortBy === 'popular_month') {
      const cutoff = new Date(Date.now() - 30 * 86_400_000);
      where.createdAt = { ...((where.createdAt as object) || {}), gte: cutoff };
      orderBy = { likeCount: 'desc' };
    }

    const [items, totalCount] = await Promise.all([
      ctx.prisma.photo.findMany({
        where,
        orderBy,
        skip,
        take: take + 1,
        include: {
          user: true,
          variants: true,
          tags: true,
          aircraft: {
            include: { manufacturer: true, family: true, variant: true, airlineRef: true },
          },
          location: { include: { airport: true, spottingLocation: true } },
          photoCategory: true,
          aircraftSpecificCategory: true,
        },
      }),
      ctx.prisma.photo.count({ where }),
    ]);

    // For random sort, shuffle the fetched page in-memory (Fisher-Yates).
    if (isRandom) {
      for (let i = items.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [items[i], items[j]] = [items[j], items[i]];
      }
    }

    const hasNextPage = items.length > take;
    const edges = items.slice(0, take).map((photo) => ({
      cursor: encodeCursor(photo.createdAt),
      node: photo,
    }));

    return {
      edges,
      pageInfo: {
        hasNextPage,
        endCursor: edges.length > 0 ? edges[edges.length - 1].cursor : null,
      },
      totalCount,
    };
  },

  /**
   * Single random approved photo, used by the home-page hero banner.
   *
   * Selecting a random row efficiently on a large table is non-trivial:
   *   - `ORDER BY random() LIMIT 1` is O(N) and gets slow once the
   *     table has even a few hundred thousand rows.
   *   - Sampling tricks like `TABLESAMPLE` aren't compatible with the
   *     partial filter we need (only approved + not deleted), so they
   *     can return zero rows on small/sparse datasets.
   *
   * We use the cheaper "count + random offset" technique: a single
   * indexed COUNT (cheap thanks to the partial `photos_feed_recent_idx`
   * added in migration 20260527190620), one Math.random() in JS, then
   * one indexed lookup with OFFSET. Total cost: two index-only scans.
   */
  randomPhoto: async (_parent: unknown, args: { awardSlug?: string }, ctx: Context) => {
    // Restrict to AIRCRAFT photos: the hero banner is a general-feed
    // surface, and community photos belong inside their community
    // context (mirrors the default applied in the `photos` resolver
    // for unscoped queries).
    //
    // When called for the hero banner (an `awardSlug` is supplied), we
    // additionally need a landscape, reasonably-wide photo. The hero is
    // a full-width × ~360px-tall band — a portrait photo crops to a
    // thin vertical slice with `cover`, hiding the subject. We push
    // the size minimum to the DB (cheaper) and the orientation check
    // to JS (Prisma can't compare two columns in a plain where).
    const baseWhere = {
      moderationStatus: 'approved' as const,
      isDeleted: false,
      kind: 'AIRCRAFT' as const,
      ...(args.awardSlug
        ? {
            awardedBadges: {
              some: { badgeDefinition: { slug: args.awardSlug, isActive: true } },
            },
            originalWidth: { not: null, gte: 1600 },
            originalHeight: { not: null },
          }
        : {}),
    };
    const total = await ctx.prisma.photo.count({ where: baseWhere });
    if (total === 0) return null;
    const include = {
      user: true,
      variants: true,
      tags: true,
      aircraft: {
        include: { manufacturer: true, family: true, variant: true, airlineRef: true },
      },
      location: { include: { airport: true, spottingLocation: true } },
      photoCategory: true,
      aircraftSpecificCategory: true,
    };
    // For the hero (awardSlug set) we re-pick a few times if our
    // random offset lands on a portrait photo. Bounded retries keep
    // the worst case cheap — on a 100% landscape corpus this is one
    // query; on a sparse dataset it falls through to whatever the
    // last pick was, then filters to landscape again as a hard cap.
    const maxAttempts = args.awardSlug ? 6 : 1;
    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      const offset = Math.floor(Math.random() * total);
      const candidate = await ctx.prisma.photo.findFirst({
        where: baseWhere,
        // Stable ordering required so OFFSET is deterministic for the
        // duration of one request. createdAt has an index, so this is
        // an index scan, not a full sort.
        orderBy: { createdAt: 'desc' },
        skip: offset,
        include,
      });
      if (!candidate) return null;
      if (!args.awardSlug) return candidate;
      if (
        candidate.originalWidth != null &&
        candidate.originalHeight != null &&
        candidate.originalWidth > candidate.originalHeight
      ) {
        return candidate;
      }
    }
    // All attempts hit portrait photos. Return the last candidate so
    // the hero at least shows something rather than falling back to
    // the site banner.
    return ctx.prisma.photo.findFirst({
      where: baseWhere,
      orderBy: { createdAt: 'desc' },
      skip: Math.floor(Math.random() * total),
      include,
    });
  },

  myUploads: async (
    _parent: unknown,
    args: { moderationStatus?: string; first?: number; after?: string; page?: number },
    ctx: Context,
  ) => {
    const authUser = requireAuth(ctx);
    const dbUser = await ctx.prisma.user.findUnique({
      where: { cognitoSub: authUser.sub },
      select: { id: true },
    });
    if (!dbUser) {
      throw new GraphQLError('User not found', { extensions: { code: 'NOT_FOUND' } });
    }

    const { skip, take, cursorWhere } = buildPaginationArgs({
      first: args.first,
      after: args.after,
      page: args.page,
    });

    const where: Record<string, unknown> = { userId: dbUser.id };
    if (args.moderationStatus) {
      where.moderationStatus = args.moderationStatus;
    }
    if (cursorWhere) {
      Object.assign(where, cursorWhere);
    }

    const [items, totalCount, totalPendingCount, pendingPositions] = await Promise.all([
      ctx.prisma.photo.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip,
        take: take + 1,
        include: { user: true, variants: true, tags: true },
      }),
      ctx.prisma.photo.count({ where }),
      ctx.prisma.photo.count({ where: { moderationStatus: 'pending' } }),
      ctx.prisma.$queryRawUnsafe<{ id: string; position: bigint }[]>(
        `SELECT id, ROW_NUMBER() OVER (ORDER BY created_at ASC) as position FROM photos WHERE moderation_status = 'pending'`,
      ),
    ]);

    const positionMap = new Map(pendingPositions.map((r) => [r.id, Number(r.position)]));

    const hasNextPage = items.length > take;
    const edges = items.slice(0, take).map((photo) => ({
      cursor: encodeCursor(photo.createdAt),
      node: photo,
      queuePosition:
        photo.moderationStatus === 'pending' ? (positionMap.get(photo.id) ?? null) : null,
    }));

    return {
      edges,
      pageInfo: {
        hasNextPage,
        endCursor: edges.length > 0 ? edges[edges.length - 1].cursor : null,
      },
      totalCount,
      totalPendingCount,
    };
  },
};

// ─── Mutation Resolvers ─────────────────────────────────────────────────────

export const photoMutationResolvers = {
  getUploadUrl: async (
    _parent: unknown,
    args: { input: { mimeType: string; fileSizeBytes: number } },
    ctx: Context,
  ) => {
    const authUser = requireAuth(ctx);
    const user = await ctx.prisma.user.findUnique({
      where: { cognitoSub: authUser.sub },
      select: { id: true, tierId: true },
    });
    if (!user) {
      throw new GraphQLError('User not found', { extensions: { code: 'NOT_FOUND' } });
    }

    // Validate file type and size against the shared minimums (per-tier
    // file-size differentiation is not yet wired through the DB tiers).
    const uploadError = validateUpload(args.input.fileSizeBytes, args.input.mimeType, 'free');
    if (uploadError) {
      throw new GraphQLError(uploadError, { extensions: { code: 'BAD_USER_INPUT' } });
    }

    // Resolve the user's tier (or fall back to the 'free' tier seeded
    // by the migration). Any superuser-managed change to upload caps in
    // /admin/tiers takes effect on the next upload — no caching here.
    const tier = user.tierId
      ? await ctx.prisma.userTier.findUnique({ where: { id: user.tierId } })
      : await ctx.prisma.userTier.findUnique({ where: { slug: 'free' } });

    // Enforce rolling daily and weekly upload quotas. A null cap means
    // unlimited; the count query is skipped when both caps are unlimited
    // to save a roundtrip.
    const dailyCap = tier?.uploadsPerDay ?? null;
    const weeklyCap = tier?.uploadsPerWeek ?? null;
    if (dailyCap != null) {
      const dayAgo = new Date(Date.now() - 24 * 60 * 60 * 1000);
      const uploadsToday = await ctx.prisma.photo.count({
        where: { userId: user.id, createdAt: { gte: dayAgo } },
      });
      if (uploadsToday >= dailyCap) {
        throw new GraphQLError(
          `Daily upload limit reached (${dailyCap} photos/day). Upgrade for higher limits.`,
          { extensions: { code: 'FORBIDDEN' } },
        );
      }
    }
    if (weeklyCap != null) {
      const weekAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
      const uploadsThisWeek = await ctx.prisma.photo.count({
        where: { userId: user.id, createdAt: { gte: weekAgo } },
      });
      if (uploadsThisWeek >= weeklyCap) {
        throw new GraphQLError(
          `Weekly upload limit reached (${weeklyCap} photos/week). Upgrade for higher limits.`,
          { extensions: { code: 'FORBIDDEN' } },
        );
      }
    }

    return getPresignedUploadUrl(user.id, args.input.mimeType);
  },

  createPhoto: async (_parent: unknown, args: { input: CreatePhotoInput }, ctx: Context) => {
    const authUser = requireAuth(ctx);
    const user = await ctx.prisma.user.findUnique({
      where: { cognitoSub: authUser.sub },
      include: { profile: true },
    });
    if (!user) {
      throw new GraphQLError('User not found', { extensions: { code: 'NOT_FOUND' } });
    }

    const { input } = args;
    validateStringLength(input.caption, 'Caption', 0, 2000);
    validateArrayLength(input.tags, 'Tags', 30);

    // Discriminate aircraft vs community photo and enforce community category when applicable.
    const kind: 'AIRCRAFT' | 'COMMUNITY' = input.kind === 'COMMUNITY' ? 'COMMUNITY' : 'AIRCRAFT';
    if (kind === 'COMMUNITY' && !input.communityCategory) {
      throw new GraphQLError('communityCategory is required for community photos', {
        extensions: { code: 'BAD_USER_INPUT' },
      });
    }
    const isCommunity = kind === 'COMMUNITY';

    // Validate the optional watermark configuration. Out-of-range or
    // invalid values are rejected before we hit the database or call
    // into Sharp, so a bad client cannot corrupt persisted rows.
    if (input.watermarkConfig) {
      const watermarkError = validateWatermarkConfig(input.watermarkConfig);
      if (watermarkError) {
        throw new GraphQLError(watermarkError, { extensions: { code: 'BAD_USER_INPUT' } });
      }
    }
    // Effective watermarking is on if the user supplied a config OR set the
    // legacy boolean. Persisting both keeps the boolean accurate for old
    // clients still reading watermarkEnabled directly.
    const watermarkEnabled = !!input.watermarkConfig || (input.watermarkEnabled ?? false);

    // Validate image dimensions using admin-configured limits from SiteSettings
    const { getObject } = await import('../services/s3.js');
    const originalBuffer = await getObject(input.s3Key);
    const sharp = await getSharp();
    const metadata = await sharp(originalBuffer).metadata();
    const originalWidth = metadata.width ?? 0;
    const originalHeight = metadata.height ?? 0;
    const longEdge = Math.max(originalWidth, originalHeight);

    const siteSettings = await ctx.prisma.siteSettings.findUnique({
      where: { id: 'site_settings' },
    });
    const minLongEdge = siteSettings?.minPhotoLongEdge ?? USER_TIER_LIMITS.free.minLongEdge;
    const maxLongEdge = siteSettings?.maxPhotoLongEdge ?? USER_TIER_LIMITS.free.maxResolution;

    if (longEdge < minLongEdge) {
      throw new GraphQLError(
        `Image is too small. Minimum ${minLongEdge}px on the long edge required (yours is ${longEdge}px).`,
        { extensions: { code: 'BAD_USER_INPUT' } },
      );
    }
    if (longEdge > maxLongEdge) {
      throw new GraphQLError(
        `Image resolution too high. Maximum ${maxLongEdge}px on the long edge (yours is ${longEdge}px).`,
        { extensions: { code: 'BAD_USER_INPUT' } },
      );
    }

    // Validate latitude/longitude ranges before creating the photo
    if (input.latitude != null && (input.latitude < -90 || input.latitude > 90)) {
      throw new GraphQLError('Latitude must be between -90 and 90', {
        extensions: { code: 'BAD_USER_INPUT' },
      });
    }
    if (input.longitude != null && (input.longitude < -180 || input.longitude > 180)) {
      throw new GraphQLError('Longitude must be between -180 and 180', {
        extensions: { code: 'BAD_USER_INPUT' },
      });
    }

    const originalUrl = getObjectUrl(input.s3Key);

    // Auto-credit photographer to uploader, photographerName from profile displayName
    const photographerId = user.id;
    const photographerName = user.profile?.displayName ?? user.username;

    // Create the photo record
    const photo = await ctx.prisma.photo.create({
      data: {
        userId: user.id,
        caption: input.caption,
        airline: isCommunity ? null : input.airline,
        airportCode: input.airportCode,
        takenAt: input.takenAt ? new Date(input.takenAt) : null,
        originalUrl,
        fileSizeBytes: input.fileSizeBytes,
        mimeType: input.mimeType,
        originalWidth,
        originalHeight,
        photographerId,
        photographerName,
        aircraftId: isCommunity ? null : (input.aircraftId ?? null),
        gearBody: input.gearBody ?? null,
        gearLens: input.gearLens ?? null,
        exifData: input.exifData ?? undefined,
        photoCategoryId: input.photoCategoryId ?? null,
        aircraftSpecificCategoryId: isCommunity ? null : (input.aircraftSpecificCategoryId ?? null),
        operatorIcao: isCommunity ? null : (input.operatorIcao ?? null),
        operatorType: isCommunity
          ? null
          : input.operatorType
            ? (input.operatorType.toLowerCase() as
                | 'airline'
                | 'general_aviation'
                | 'military'
                | 'government'
                | 'cargo'
                | 'charter'
                | 'private')
            : null,
        msn: isCommunity ? null : (input.msn ?? null),
        manufacturingDate: isCommunity ? null : (input.manufacturingDate ?? null),
        kind,
        communityCategory: isCommunity
          ? (input.communityCategory as
              | 'SCENERY'
              | 'EVENT'
              | 'HANGAR'
              | 'AIRPORT'
              | 'PEOPLE'
              | 'OTHER')
          : null,
        // In dev, auto-approve; in production, start as pending
        moderationStatus: process.env.NODE_ENV === 'production' ? 'pending' : 'approved',
        license: (input.license ?? 'ALL_RIGHTS_RESERVED') as
          | 'ALL_RIGHTS_RESERVED'
          | 'CC_BY_NC_ND'
          | 'CC_BY_NC'
          | 'CC_BY_NC_SA'
          | 'CC_BY'
          | 'CC_BY_SA',
        watermarkEnabled,
        watermarkPosition: input.watermarkConfig?.position ?? null,
        watermarkSize: input.watermarkConfig?.sizePct ?? null,
        watermarkOpacity: input.watermarkConfig?.opacityPct ?? null,
        tags: input.tags
          ? { create: input.tags.map((tag) => ({ tag: tag.toLowerCase().trim() })) }
          : undefined,
      },
      include: { user: true, variants: true, tags: true },
    });

    // Generate image variants asynchronously (in dev, synchronous for simplicity)
    try {
      const variants = await generateVariants(input.s3Key, {
        watermark: {
          enabled: watermarkEnabled,
          config: input.watermarkConfig,
        },
      });
      for (const variant of variants) {
        await ctx.prisma.photoVariant.create({
          data: {
            photoId: photo.id,
            variantType: variant.variantType,
            url: variant.url,
            width: variant.width,
            height: variant.height,
            fileSizeBytes: variant.fileSizeBytes,
          },
        });
      }

      // Update original dimensions from the first variant's source
      if (variants.length > 0) {
        // Re-fetch to get updated variants
        return ctx.prisma.photo.findUnique({
          where: { id: photo.id },
          include: { user: true, variants: true, tags: true },
        });
      }
    } catch (err) {
      // Log but don't fail — photo is created, variants can be retried
      console.error('Variant generation failed:', err);
    }

    // Create location if coordinates provided
    if (input.latitude != null && input.longitude != null) {
      const privacyMode = input.locationPrivacy ?? 'exact';
      const { displayLat, displayLng } = applyPrivacy(input.latitude, input.longitude, privacyMode);

      // Find associated airport by airportIcao or airportCode
      let airportId: string | null = null;
      let country: string | null = null;
      const lookupCode = (input.airportIcao ?? input.airportCode ?? '').trim().toUpperCase();
      if (lookupCode) {
        const airport = await ctx.prisma.airport.findFirst({
          where: { OR: [{ icaoCode: lookupCode }, { iataCode: lookupCode }] },
        });
        if (airport) {
          airportId = airport.id;
          country = airport.country;
        }
      }

      await ctx.prisma.photoLocation.create({
        data: {
          photoId: photo.id,
          // Don't store raw coordinates when privacy is hidden — only display coords
          rawLatitude: privacyMode !== 'hidden' ? input.latitude : null,
          rawLongitude: privacyMode !== 'hidden' ? input.longitude : null,
          displayLatitude: displayLat,
          displayLongitude: displayLng,
          privacyMode: privacyMode as 'exact' | 'approximate' | 'hidden',
          airportId,
          locationType: input.locationType ?? (airportId ? 'airport' : null),
          country,
        },
      });
    }

    // Check for badge awards (fire-and-forget)
    checkAndAwardBadges(ctx, user.id, 'photo_count').catch(() => {});
    checkAndAwardBadges(ctx, user.id, 'unique_airport_count').catch(() => {});
    checkAndAwardBadges(ctx, user.id, 'upload_streak_days').catch(() => {});

    // Re-fetch to include location data
    return (
      ctx.prisma.photo.findUnique({
        where: { id: photo.id },
        include: { user: true, variants: true, tags: true },
      }) ?? photo
    );
  },

  updatePhoto: async (
    _parent: unknown,
    args: { id: string; input: UpdatePhotoInput },
    ctx: Context,
  ) => {
    const authUser = requireAuth(ctx);
    const user = await ctx.prisma.user.findUnique({
      where: { cognitoSub: authUser.sub },
      select: { id: true, role: true },
    });
    if (!user) {
      throw new GraphQLError('User not found', { extensions: { code: 'NOT_FOUND' } });
    }

    const photo = await ctx.prisma.photo.findUnique({
      where: { id: args.id },
      select: { userId: true },
    });
    if (!photo) {
      throw new GraphQLError('Photo not found', { extensions: { code: 'NOT_FOUND' } });
    }

    // Admin/moderator/superuser can edit any photo; everyone else must be the owner.
    const isPrivileged =
      user.role === 'admin' || user.role === 'moderator' || user.role === 'superuser';

    if (!isPrivileged && photo.userId !== user.id) {
      throw new GraphQLError('You do not have permission to edit this photo', {
        extensions: { code: 'FORBIDDEN' },
      });
    }

    // Validate latitude/longitude ranges if provided
    if (
      args.input.latitude !== undefined &&
      args.input.latitude !== null &&
      (args.input.latitude < -90 || args.input.latitude > 90)
    ) {
      throw new GraphQLError('Latitude must be between -90 and 90', {
        extensions: { code: 'BAD_USER_INPUT' },
      });
    }
    if (
      args.input.longitude !== undefined &&
      args.input.longitude !== null &&
      (args.input.longitude < -180 || args.input.longitude > 180)
    ) {
      throw new GraphQLError('Longitude must be between -180 and 180', {
        extensions: { code: 'BAD_USER_INPUT' },
      });
    }

    validateStringLength(args.input.caption, 'Caption', 0, 2000);
    validateArrayLength(args.input.tags, 'Tags', 30);

    const {
      tags,
      takenAt,
      latitude,
      longitude,
      locationPrivacy,
      aircraftId,
      gearBody,
      gearLens,
      exifData,
      photoCategoryId,
      aircraftSpecificCategoryId,
      operatorIcao,
      operatorType,
      msn,
      manufacturingDate,
      locationType,
      airportIcao,
      kind,
      communityCategory,
      ...rest
    } = args.input;

    // Update tags if provided: delete existing, create new
    if (tags !== undefined) {
      await ctx.prisma.photoTag.deleteMany({ where: { photoId: args.id } });
      if (tags.length > 0) {
        await ctx.prisma.photoTag.createMany({
          data: tags.map((tag) => ({
            photoId: args.id,
            tag: tag.toLowerCase().trim(),
          })),
        });
      }
    }

    // Update location if coordinates provided
    if (latitude !== undefined) {
      if (latitude != null && longitude != null) {
        const privacyMode = locationPrivacy ?? 'exact';
        const { displayLat, displayLng } = applyPrivacy(latitude, longitude, privacyMode);

        // Find associated airport by airportIcao or airportCode
        let airportId: string | null = null;
        let country: string | null = null;
        const lookupCode = (airportIcao ?? '').trim().toUpperCase();
        if (lookupCode) {
          const airport = await ctx.prisma.airport.findFirst({
            where: { OR: [{ icaoCode: lookupCode }, { iataCode: lookupCode }] },
          });
          if (airport) {
            airportId = airport.id;
            country = airport.country;
          }
        }

        await ctx.prisma.photoLocation.upsert({
          where: { photoId: args.id },
          update: {
            // Don't store raw coordinates when privacy is hidden
            rawLatitude: privacyMode !== 'hidden' ? latitude : null,
            rawLongitude: privacyMode !== 'hidden' ? longitude : null,
            displayLatitude: displayLat,
            displayLongitude: displayLng,
            privacyMode: privacyMode as 'exact' | 'approximate' | 'hidden',
            ...(airportId !== undefined && { airportId }),
            ...(locationType !== undefined && { locationType: locationType ?? null }),
            ...(country !== undefined && { country }),
          },
          create: {
            photoId: args.id,
            // Don't store raw coordinates when privacy is hidden
            rawLatitude: privacyMode !== 'hidden' ? latitude : null,
            rawLongitude: privacyMode !== 'hidden' ? longitude : null,
            displayLatitude: displayLat,
            displayLongitude: displayLng,
            privacyMode: privacyMode as 'exact' | 'approximate' | 'hidden',
            airportId,
            locationType: locationType ?? (airportId ? 'airport' : null),
            country,
          },
        });
      } else {
        // Remove location if latitude explicitly set to null
        await ctx.prisma.photoLocation.deleteMany({ where: { photoId: args.id } });
      }
    }

    return ctx.prisma.photo.update({
      where: { id: args.id },
      data: {
        ...rest,
        ...(takenAt !== undefined && { takenAt: takenAt ? new Date(takenAt) : null }),
        ...(aircraftId !== undefined && { aircraftId: aircraftId ?? null }),
        ...(gearBody !== undefined && { gearBody: gearBody ?? null }),
        ...(gearLens !== undefined && { gearLens: gearLens ?? null }),
        ...(exifData !== undefined && { exifData: exifData ?? undefined }),
        ...(photoCategoryId !== undefined && { photoCategoryId: photoCategoryId ?? null }),
        ...(aircraftSpecificCategoryId !== undefined && {
          aircraftSpecificCategoryId: aircraftSpecificCategoryId ?? null,
        }),
        ...(operatorIcao !== undefined && { operatorIcao: operatorIcao ?? null }),
        ...(operatorType !== undefined && {
          operatorType: operatorType
            ? (operatorType.toLowerCase() as
                | 'airline'
                | 'general_aviation'
                | 'military'
                | 'government'
                | 'cargo'
                | 'charter'
                | 'private')
            : null,
        }),
        ...(msn !== undefined && { msn: msn ?? null }),
        ...(manufacturingDate !== undefined && { manufacturingDate: manufacturingDate ?? null }),
        ...(kind !== undefined && { kind }),
        ...(communityCategory !== undefined && { communityCategory: communityCategory ?? null }),
        ...(kind === 'COMMUNITY' && {
          aircraftId: null,
          airline: null,
          operatorIcao: null,
          operatorType: null,
          msn: null,
          manufacturingDate: null,
          aircraftSpecificCategoryId: null,
        }),
      },
      include: { user: true, variants: true, tags: true },
    });
  },

  approvePhoto: async (_parent: unknown, args: { photoId: string }, ctx: Context) => {
    await requireRole(ctx, ['admin', 'moderator', 'superuser']);

    const photo = await ctx.prisma.photo.findUnique({ where: { id: args.photoId } });
    if (!photo) {
      throw new GraphQLError('Photo not found', { extensions: { code: 'NOT_FOUND' } });
    }

    return ctx.prisma.photo.update({
      where: { id: args.photoId },
      data: { moderationStatus: 'approved' },
      include: { user: true, variants: true, tags: true },
    });
  },

  rejectPhoto: async (
    _parent: unknown,
    args: { photoId: string; reason?: string },
    ctx: Context,
  ) => {
    await requireRole(ctx, ['admin', 'moderator', 'superuser']);

    const photo = await ctx.prisma.photo.findUnique({ where: { id: args.photoId } });
    if (!photo) {
      throw new GraphQLError('Photo not found', { extensions: { code: 'NOT_FOUND' } });
    }

    const updated = await ctx.prisma.photo.update({
      where: { id: args.photoId },
      data: {
        moderationStatus: 'rejected',
        ...(args.reason && { moderationLabels: { reason: args.reason } }),
      },
      include: { user: true, variants: true, tags: true },
    });

    // Notify the photo owner that their photo was rejected.
    // Awaited so the moderation message is guaranteed to be persisted before the mutation
    // returns; createNotification swallows internal errors.
    await createNotification(ctx.prisma, {
      userId: photo.userId,
      type: 'moderation',
      title: '🚫 Photo rejected',
      body: args.reason
        ? `Your photo was rejected: ${args.reason}`
        : 'Your photo was rejected by a moderator.',
      data: { photoId: photo.id, reason: args.reason ?? null },
    });

    return updated;
  },

  deletePhoto: async (_parent: unknown, args: { id: string }, ctx: Context) => {
    const authUser = requireAuth(ctx);
    const user = await ctx.prisma.user.findUnique({
      where: { cognitoSub: authUser.sub },
      select: { id: true, role: true },
    });
    if (!user) {
      throw new GraphQLError('User not found', { extensions: { code: 'NOT_FOUND' } });
    }

    const photo = await ctx.prisma.photo.findUnique({
      where: { id: args.id },
      select: { userId: true },
    });
    if (!photo) {
      throw new GraphQLError('Photo not found', { extensions: { code: 'NOT_FOUND' } });
    }

    // Admin/moderator/superuser can delete any photo
    const isPrivileged =
      user.role === 'admin' || user.role === 'moderator' || user.role === 'superuser';

    if (!isPrivileged && photo.userId !== user.id) {
      throw new GraphQLError('You do not have permission to delete this photo', {
        extensions: { code: 'FORBIDDEN' },
      });
    }

    await ctx.prisma.photo.delete({ where: { id: args.id } });
    return true;
  },

  softDeletePhoto: async (
    _parent: unknown,
    args: { id: string; reason?: string },
    ctx: Context,
  ) => {
    await requireRole(ctx, ['admin', 'moderator', 'superuser']);
    const dbUser = await getDbUser(ctx);

    const photo = await ctx.prisma.photo.findUnique({ where: { id: args.id } });
    if (!photo) {
      throw new GraphQLError('Photo not found', { extensions: { code: 'NOT_FOUND' } });
    }

    await ctx.prisma.communityModerationLog.create({
      data: {
        communityId: 'global',
        moderatorId: dbUser.id,
        targetUserId: photo.userId,
        action: 'delete_photo',
        reason: args.reason ?? 'Soft delete requested',
        metadata: { photoId: photo.id, mode: 'SOFT' },
      },
    });

    await ctx.prisma.photo.update({
      where: { id: args.id },
      data: { isDeleted: true },
    });
    return true;
  },

  hardDeletePhoto: async (_parent: unknown, args: { id: string; reason: string }, ctx: Context) => {
    await requireRole(ctx, ['admin', 'moderator', 'superuser']);
    const dbUser = await getDbUser(ctx);

    if (!args.reason) {
      throw new GraphQLError('A reason is required for hard deletion', {
        extensions: { code: 'BAD_USER_INPUT' },
      });
    }

    const photo = await ctx.prisma.photo.findUnique({ where: { id: args.id } });
    if (!photo) {
      throw new GraphQLError('Photo not found', { extensions: { code: 'NOT_FOUND' } });
    }

    await ctx.prisma.communityModerationLog.create({
      data: {
        communityId: 'global',
        moderatorId: dbUser.id,
        targetUserId: photo.userId,
        action: 'delete_photo',
        reason: args.reason,
        metadata: { photoId: photo.id, mode: 'HARD' },
      },
    });

    await ctx.prisma.photo.delete({ where: { id: args.id } });
    return true;
  },

  regeneratePhotoVariants: async (_parent: unknown, args: { photoId: string }, ctx: Context) => {
    const authUser = requireAuth(ctx);
    const user = await ctx.prisma.user.findUnique({
      where: { cognitoSub: authUser.sub },
      select: { id: true, role: true },
    });
    if (!user) {
      throw new GraphQLError('User not found', { extensions: { code: 'NOT_FOUND' } });
    }

    const photo = await ctx.prisma.photo.findUnique({
      where: { id: args.photoId },
      include: { user: true, variants: true, tags: true },
    });
    if (!photo) {
      throw new GraphQLError('Photo not found', { extensions: { code: 'NOT_FOUND' } });
    }

    // Only owner or privileged users can regenerate
    const isPrivileged = ['admin', 'moderator', 'superuser'].includes(user.role);
    if (photo.userId !== user.id && !isPrivileged) {
      throw new GraphQLError('Not authorized', { extensions: { code: 'FORBIDDEN' } });
    }

    // Derive S3 key from originalUrl by stripping the host prefix
    const url = new URL(photo.originalUrl);
    const s3Key = url.pathname.startsWith('/') ? url.pathname.slice(1) : url.pathname;

    // Delete existing variants
    await ctx.prisma.photoVariant.deleteMany({ where: { photoId: photo.id } });

    // Regenerate variants. Pass through the persisted watermark config so
    // the regenerated `watermarked` variant matches what the uploader chose.
    // For legacy photos without a config, generateVariants falls back to
    // WATERMARK_DEFAULTS.
    //
    // The DB enum and the shared enum share identical string values but are
    // nominally distinct types in TypeScript; translate at the boundary by
    // looking up the shared enum member by its string value.
    const persistedWatermarkConfig: WatermarkConfig | undefined =
      photo.watermarkPosition && photo.watermarkSize != null && photo.watermarkOpacity != null
        ? {
            position: WatermarkPosition[photo.watermarkPosition],
            sizePct: photo.watermarkSize,
            opacityPct: photo.watermarkOpacity,
          }
        : undefined;
    const variants = await generateVariants(s3Key, {
      watermark: {
        enabled: photo.watermarkEnabled,
        config: persistedWatermarkConfig,
      },
    });

    for (const variant of variants) {
      await ctx.prisma.photoVariant.create({
        data: {
          photoId: photo.id,
          variantType: variant.variantType,
          url: variant.url,
          width: variant.width,
          height: variant.height,
          fileSizeBytes: variant.fileSizeBytes,
        },
      });
    }

    return ctx.prisma.photo.findUnique({
      where: { id: photo.id },
      include: { user: true, variants: true, tags: true },
    });
  },
};

// ─── Field Resolvers ────────────────────────────────────────────────────────

export const photoFieldResolvers = {
  user: (parent: PhotoParent & { user?: unknown }, _args: unknown, ctx: Context) => {
    // If user was already included by Prisma, use it directly
    if (parent.user) return parent.user;
    return ctx.prisma.user.findUnique({ where: { id: parent.userId } });
  },

  /**
   * Per-photo watermark configuration. Returns null for legacy photos
   * uploaded before user-configurable watermarks (or for photos without
   * a watermark) so the GraphQL nullable field stays accurate.
   */
  watermarkConfig: (parent: PhotoParent) => {
    if (
      !parent.watermarkPosition ||
      parent.watermarkSize == null ||
      parent.watermarkOpacity == null
    ) {
      return null;
    }
    return {
      position: parent.watermarkPosition,
      sizePct: parent.watermarkSize,
      opacityPct: parent.watermarkOpacity,
    };
  },

  variants: (parent: PhotoParent & { variants?: unknown[] }, _args: unknown, ctx: Context) => {
    if (parent.variants) return parent.variants;
    return ctx.prisma.photoVariant.findMany({ where: { photoId: parent.id } });
  },

  /**
   * UserBadge rows awarded specifically against this photo (via
   * UserBadge.awardedPhotoId). Reverse relation of UserBadge.awardedPhoto.
   * Includes the badgeDefinition so the AdminChoiceButton can match by slug
   * on the client without a second round trip.
   */
  awardedBadges: (
    parent: PhotoParent & { awardedBadges?: unknown },
    _args: unknown,
    ctx: Context,
  ) => {
    if (parent.awardedBadges) return parent.awardedBadges;
    return ctx.prisma.userBadge.findMany({
      where: { awardedPhotoId: parent.id },
      include: {
        badgeDefinition: true,
        user: true,
        awardedPhoto: true,
        awarder: true,
      },
    });
  },

  tags: async (
    parent: PhotoParent & { tags?: Array<{ tag: string }> | string[] },
    _args: unknown,
    ctx: Context,
  ) => {
    if (parent.tags) {
      // If already resolved to string array, return directly
      if (parent.tags.length === 0) return [];
      if (typeof parent.tags[0] === 'string') return parent.tags;
      // Otherwise, it's the Prisma relation shape: { tag: string }[]
      return (parent.tags as Array<{ tag: string }>).map((t) => t.tag);
    }
    const tags = await ctx.prisma.photoTag.findMany({
      where: { photoId: parent.id },
      select: { tag: true },
    });
    return tags.map((t) => t.tag);
  },

  // Rejection reason — only the photo owner and moderators/admins may see it.
  // For everyone else (anonymous viewers, other users) we return null so the
  // moderator's explanation does not leak publicly. Returns null if the photo
  // is not rejected or no reason was recorded.
  rejectionReason: async (parent: PhotoParent, _args: unknown, ctx: Context) => {
    if (parent.moderationStatus !== 'rejected') return null;

    const labels = parent.moderationLabels;
    const reason =
      labels && typeof labels === 'object' && !Array.isArray(labels)
        ? (labels as Record<string, unknown>).reason
        : null;
    if (typeof reason !== 'string' || reason.trim() === '') return null;

    if (!ctx.user) return null;

    const viewer = await ctx.prisma.user.findUnique({
      where: { cognitoSub: ctx.user.sub },
      select: { id: true, role: true },
    });
    if (!viewer) return null;

    const isOwner = viewer.id === parent.userId;
    const isPrivileged = ['admin', 'moderator', 'superuser'].includes(viewer.role);
    if (!isOwner && !isPrivileged) return null;

    return reason;
  },

  likeCount: (parent: PhotoParent, _args: unknown, ctx: Context) => {
    return ctx.loaders.photoLikeCount.load(parent.id);
  },

  commentCount: (parent: PhotoParent, _args: unknown, ctx: Context) => {
    return ctx.loaders.photoCommentCount.load(parent.id);
  },

  location: async (parent: PhotoParent, _args: unknown, ctx: Context) => {
    const loc = await ctx.loaders.photoLocation.load(parent.id);
    if (!loc || loc.privacyMode === 'hidden') return null;
    return {
      id: loc.id,
      latitude: loc.displayLatitude,
      longitude: loc.displayLongitude,
      privacyMode: loc.privacyMode,
      locationType: loc.locationType,
      country: loc.country,
      airport: loc.airport,
      spottingLocation: loc.spottingLocation,
    };
  },

  aircraft: (
    parent: PhotoParent & { aircraftId?: string | null },
    _args: unknown,
    ctx: Context,
  ) => {
    if (!parent.aircraftId) return null;
    return ctx.loaders.aircraftById.load(parent.aircraftId);
  },

  photographer: (
    parent: PhotoParent & { photographerId?: string | null },
    _args: unknown,
    ctx: Context,
  ) => {
    if (!parent.photographerId) return null;
    return ctx.loaders.userById.load(parent.photographerId);
  },

  takenAt: (parent: { takenAt: Date | null }) => parent.takenAt?.toISOString() ?? null,

  createdAt: (parent: { createdAt: Date | null }) => parent.createdAt?.toISOString() ?? null,

  operatorType: (parent: { operatorType: string | null }) =>
    parent.operatorType
      ? (parent.operatorType.toUpperCase() as
          | 'AIRLINE'
          | 'GENERAL_AVIATION'
          | 'MILITARY'
          | 'GOVERNMENT'
          | 'CARGO'
          | 'CHARTER'
          | 'PRIVATE')
      : null,

  exifData: (parent: PhotoParent) => parent.exifData ?? null,

  photoCategory: (parent: PhotoParent, _args: unknown, ctx: Context) => {
    if (!parent.photoCategoryId) return null;
    return ctx.prisma.photoCategory.findUnique({ where: { id: parent.photoCategoryId } });
  },

  aircraftSpecificCategory: (parent: PhotoParent, _args: unknown, ctx: Context) => {
    if (!parent.aircraftSpecificCategoryId) return null;
    return ctx.prisma.aircraftSpecificCategory.findUnique({
      where: { id: parent.aircraftSpecificCategoryId },
    });
  },

  /**
   * The community a photo belongs to, resolved via its album. Returns
   * null when the photo has no album, or the album has no community.
   *
   * If a parent resolver already included `album.community`, we use it
   * directly (zero extra queries). Otherwise we fall back to a single
   * indexed lookup that joins photo → album → community. This is the
   * path the home-page feed takes today; it's a small N+1 we accept
   * because per-card community attribution is only rendered for cards
   * currently in view, and Postgres serves it from the album's
   * primary-key index.
   */
  community: async (
    parent: PhotoParent & {
      album?: { community?: unknown } | null;
    },
    _args: unknown,
    ctx: Context,
  ) => {
    if (parent.album && 'community' in parent.album) {
      return parent.album.community ?? null;
    }
    if (!parent.albumId) return null;
    const album = await ctx.prisma.album.findUnique({
      where: { id: parent.albumId },
      select: { community: true },
    });
    return album?.community ?? null;
  },

  listing: (parent: PhotoParent, _args: unknown, ctx: Context) => {
    return ctx.prisma.photoListing.findUnique({
      where: { photoId: parent.id },
    });
  },

  hasActiveListing: (parent: PhotoParent & { hasActiveListing?: boolean }) => {
    return parent.hasActiveListing ?? false;
  },

  operatorIcao: (parent: PhotoParent) => parent.operatorIcao ?? null,

  similarAircraftPhotos: async (
    parent: PhotoParent,
    args: { first?: number; after?: string },
    ctx: Context,
  ) => {
    const take = Math.min(args.first ?? 12, 30);

    // Match by aircraftId if linked, otherwise by msn + manufacturerId
    const where: Record<string, unknown> = {
      id: { not: parent.id },
      moderationStatus: 'approved',
    };

    if (parent.aircraftId) {
      where.aircraftId = parent.aircraftId;
    } else if (parent.msn) {
      where.msn = parent.msn;
    } else {
      // No aircraft linked and no msn — return empty
      return {
        edges: [],
        pageInfo: { hasNextPage: false, endCursor: null },
        totalCount: 0,
      };
    }

    if (args.after) {
      const cursorPhoto = await ctx.prisma.photo.findUnique({ where: { id: args.after } });
      if (cursorPhoto) {
        where.createdAt = { lt: cursorPhoto.createdAt };
      }
    }

    const [items, totalCount] = await Promise.all([
      ctx.prisma.photo.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        take: take + 1,
        include: {
          user: { include: { profile: true } },
          variants: true,
          aircraft: { include: { manufacturer: true, family: true, variant: true } },
        },
      }),
      ctx.prisma.photo.count({ where }),
    ]);

    const hasNextPage = items.length > take;
    const edges = items.slice(0, take).map((p) => ({
      cursor: p.id,
      node: p,
    }));

    return {
      edges,
      pageInfo: {
        hasNextPage,
        endCursor: edges.length > 0 ? edges[edges.length - 1].cursor : null,
      },
      totalCount,
    };
  },
};
