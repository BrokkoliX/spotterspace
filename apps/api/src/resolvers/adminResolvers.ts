import { GraphQLError } from 'graphql';

import { requireRole } from '../auth/requireAuth.js';
import type { Context } from '../context.js';
import { encodeCursor, getDbUser, buildPaginationArgs } from '../utils/resolverHelpers.js';

import { createNotification } from './notificationResolvers.js';

// ─── Helpers ────────────────────────────────────────────────────────────────

const VALID_REPORT_ACTIONS = ['resolved', 'dismissed'];
const VALID_USER_STATUSES = ['active', 'suspended', 'banned'];
const VALID_USER_ROLES = ['user', 'moderator', 'admin', 'superuser'];
const VALID_MODERATION_STATUSES = ['pending', 'approved', 'rejected', 'review'];

// ─── Query Resolvers ────────────────────────────────────────────────────────

export const adminQueryResolvers = {
  adminStats: async (_parent: unknown, _args: unknown, ctx: Context) => {
    await requireRole(ctx, ['admin', 'moderator']);

    const [
      totalUsers,
      totalPhotos,
      pendingPhotos,
      openReports,
      totalAirports,
      totalSpottingLocations,
    ] = await Promise.all([
      ctx.prisma.user.count(),
      ctx.prisma.photo.count({ where: { isDeleted: false, moderationStatus: 'approved' } }),
      ctx.prisma.photo.count({ where: { moderationStatus: 'pending' } }),
      ctx.prisma.report.count({ where: { status: 'open' } }),
      ctx.prisma.airport.count(),
      ctx.prisma.spottingLocation.count(),
    ]);

    return {
      totalUsers,
      totalPhotos,
      pendingPhotos,
      openReports,
      totalAirports,
      totalSpottingLocations,
    };
  },

  adminReports: async (
    _parent: unknown,
    args: { status?: string; first?: number; after?: string; page?: number },
    ctx: Context,
  ) => {
    await requireRole(ctx, ['admin', 'moderator']);

    const { skip, take, cursorWhere } = buildPaginationArgs({
      first: args.first,
      after: args.after,
      page: args.page,
    });
    const where: Record<string, unknown> = {};

    if (args.status) {
      where.status = args.status;
    }
    if (cursorWhere) {
      Object.assign(where, cursorWhere);
    }

    const [items, totalCount] = await Promise.all([
      ctx.prisma.report.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip,
        take: take + 1,
        include: { reporter: true, reviewer: true },
      }),
      ctx.prisma.report.count({ where }),
    ]);

    const hasNextPage = items.length > take;
    const edges = items.slice(0, take).map((report) => ({
      cursor: encodeCursor(report.createdAt),
      node: report,
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

  adminUsers: async (
    _parent: unknown,
    args: {
      role?: string;
      status?: string;
      search?: string;
      first?: number;
      after?: string;
      page?: number;
    },
    ctx: Context,
  ) => {
    const caller = await getDbUser(ctx);
    if (caller.role !== 'superuser' && caller.role !== 'admin') {
      throw new GraphQLError('Only admins or superusers can list users', {
        extensions: { code: 'FORBIDDEN' },
      });
    }

    const { skip, take, cursorWhere } = buildPaginationArgs({
      first: args.first,
      after: args.after,
      page: args.page,
    });
    const where: Record<string, unknown> = {};

    if (args.role) {
      where.role = args.role;
    }
    if (args.status) {
      where.status = args.status;
    }
    if (args.search) {
      where.OR = [
        { username: { contains: args.search, mode: 'insensitive' } },
        { email: { contains: args.search, mode: 'insensitive' } },
      ];
    }
    if (cursorWhere) {
      Object.assign(where, cursorWhere);
    }

    const [items, totalCount] = await Promise.all([
      ctx.prisma.user.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip,
        take: take + 1,
        include: { profile: true },
      }),
      ctx.prisma.user.count({ where }),
    ]);

    const hasNextPage = items.length > take;
    const edges = items.slice(0, take).map((user) => ({
      cursor: encodeCursor(user.createdAt),
      node: { ...user, createdAt: user.createdAt.toISOString() },
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

  adminUserById: async (_parent: unknown, args: { id: string }, ctx: Context) => {
    const caller = await getDbUser(ctx);
    if (caller.role !== 'superuser' && caller.role !== 'admin') {
      throw new GraphQLError('Only admins or superusers can view user detail', {
        extensions: { code: 'FORBIDDEN' },
      });
    }

    const user = await ctx.prisma.user.findUnique({
      where: { id: args.id },
      include: { profile: true, sellerProfile: true, tier: true },
    });
    if (!user) {
      throw new GraphQLError('User not found', { extensions: { code: 'NOT_FOUND' } });
    }
    return user;
  },

  adminPhotos: async (
    _parent: unknown,
    args: { moderationStatus?: string; first?: number; after?: string; page?: number },
    ctx: Context,
  ) => {
    await requireRole(ctx, ['admin', 'moderator']);

    const { skip, take, cursorWhere } = buildPaginationArgs({
      first: args.first,
      after: args.after,
      page: args.page,
    });
    const where: Record<string, unknown> = {};

    if (args.moderationStatus) {
      where.moderationStatus = args.moderationStatus;
    }
    if (cursorWhere) {
      Object.assign(where, cursorWhere);
    }

    const [items, totalCount] = await Promise.all([
      ctx.prisma.photo.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip,
        take: take + 1,
        include: { user: true, variants: true, tags: true },
      }),
      ctx.prisma.photo.count({ where }),
    ]);

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
};

// ─── Mutation Resolvers ─────────────────────────────────────────────────────

export const adminMutationResolvers = {
  adminResolveReport: async (
    _parent: unknown,
    args: { id: string; action: string },
    ctx: Context,
  ) => {
    const authUser = await requireRole(ctx, ['admin', 'moderator']);

    if (!VALID_REPORT_ACTIONS.includes(args.action)) {
      throw new GraphQLError(`Invalid action. Must be one of: ${VALID_REPORT_ACTIONS.join(', ')}`, {
        extensions: { code: 'BAD_USER_INPUT' },
      });
    }

    const report = await ctx.prisma.report.findUnique({
      where: { id: args.id },
    });
    if (!report) {
      throw new GraphQLError('Report not found', {
        extensions: { code: 'NOT_FOUND' },
      });
    }

    const reviewer = await ctx.prisma.user.findUnique({
      where: { cognitoSub: authUser.sub },
      select: { id: true },
    });

    return ctx.prisma.report.update({
      where: { id: args.id },
      data: {
        status: args.action as 'resolved' | 'dismissed',
        reviewedBy: reviewer?.id ?? null,
        resolvedAt: new Date(),
      },
      include: { reporter: true, reviewer: true },
    });
  },

  adminUpdateUserStatus: async (
    _parent: unknown,
    args: { userId: string; status: string },
    ctx: Context,
  ) => {
    const caller = await getDbUser(ctx);
    if (caller.role !== 'superuser') {
      throw new GraphQLError('Only superusers can change user status', {
        extensions: { code: 'FORBIDDEN' },
      });
    }

    const target = await ctx.prisma.user.findUnique({ where: { id: args.userId } });
    if (!target) {
      throw new GraphQLError('User not found', { extensions: { code: 'NOT_FOUND' } });
    }

    if (!VALID_USER_STATUSES.includes(args.status)) {
      throw new GraphQLError(`Invalid status. Must be one of: ${VALID_USER_STATUSES.join(', ')}`, {
        extensions: { code: 'BAD_USER_INPUT' },
      });
    }

    return ctx.prisma.user.update({
      where: { id: args.userId },
      data: { status: args.status as 'active' | 'suspended' | 'banned' },
      include: { profile: true },
    });
  },

  adminUpdateUserRole: async (
    _parent: unknown,
    args: { userId: string; role: string },
    ctx: Context,
  ) => {
    const caller = await getDbUser(ctx);
    if (caller.role !== 'superuser') {
      throw new GraphQLError('Only superusers can change user roles', {
        extensions: { code: 'FORBIDDEN' },
      });
    }

    const target = await ctx.prisma.user.findUnique({ where: { id: args.userId } });
    if (!target) {
      throw new GraphQLError('User not found', { extensions: { code: 'NOT_FOUND' } });
    }

    if (!VALID_USER_ROLES.includes(args.role)) {
      throw new GraphQLError(`Invalid role. Must be one of: ${VALID_USER_ROLES.join(', ')}`, {
        extensions: { code: 'BAD_USER_INPUT' },
      });
    }

    return ctx.prisma.user.update({
      where: { id: args.userId },
      data: { role: args.role as 'user' | 'moderator' | 'admin' | 'superuser' },
      include: { profile: true },
    });
  },

  adminUnlockUser: async (_parent: unknown, args: { userId: string }, ctx: Context) => {
    const caller = await getDbUser(ctx);
    if (caller.role !== 'superuser') {
      throw new GraphQLError('Only superusers can unlock users', {
        extensions: { code: 'FORBIDDEN' },
      });
    }

    return ctx.prisma.user.update({
      where: { id: args.userId },
      data: { failedAttempts: 0, lockoutUntil: null },
    });
  },

  adminAssignUserTier: async (
    _parent: unknown,
    args: { userId: string; tierId: string | null },
    ctx: Context,
  ) => {
    const caller = await getDbUser(ctx);
    if (caller.role !== 'superuser') {
      throw new GraphQLError('Only superusers can assign user tiers', {
        extensions: { code: 'FORBIDDEN' },
      });
    }

    const target = await ctx.prisma.user.findUnique({ where: { id: args.userId } });
    if (!target) {
      throw new GraphQLError('User not found', { extensions: { code: 'NOT_FOUND' } });
    }

    // Verify the tier exists when provided. We allow assigning inactive
    // tiers so the superuser can move users onto a draft tier before
    // flipping it active.
    if (args.tierId) {
      const tier = await ctx.prisma.userTier.findUnique({ where: { id: args.tierId } });
      if (!tier) {
        throw new GraphQLError('Tier not found', { extensions: { code: 'NOT_FOUND' } });
      }
    }

    return ctx.prisma.user.update({
      where: { id: args.userId },
      data: { tierId: args.tierId },
      include: { profile: true, tier: true },
    });
  },

  adminUpdatePhotoModeration: async (
    _parent: unknown,
    args: { photoId: string; status: string },
    ctx: Context,
  ) => {
    await requireRole(ctx, ['admin', 'moderator']);

    if (!VALID_MODERATION_STATUSES.includes(args.status)) {
      throw new GraphQLError(
        `Invalid moderation status. Must be one of: ${VALID_MODERATION_STATUSES.join(', ')}`,
        { extensions: { code: 'BAD_USER_INPUT' } },
      );
    }

    const photo = await ctx.prisma.photo.findUnique({
      where: { id: args.photoId },
    });
    if (!photo) {
      throw new GraphQLError('Photo not found', {
        extensions: { code: 'NOT_FOUND' },
      });
    }

    const updated = await ctx.prisma.photo.update({
      where: { id: args.photoId },
      data: {
        moderationStatus: args.status as 'pending' | 'approved' | 'rejected' | 'review',
      },
      include: { user: true, variants: true, tags: true },
    });

    // Notify the photo owner only on rejection — silent for other transitions.
    // Awaited (unlike like/comment notifications) so moderation messages are guaranteed
    // to be persisted before the mutation returns. createNotification swallows errors internally.
    if (args.status === 'rejected') {
      await createNotification(ctx.prisma, {
        userId: photo.userId,
        type: 'moderation',
        title: '🚫 Photo rejected',
        body: 'Your photo was rejected by a moderator.',
        data: { photoId: photo.id },
      });
    }

    return updated;
  },

  adminImportAirports: async (_parent: unknown, args: { csvData: string }, ctx: Context) => {
    const caller = await getDbUser(ctx);
    if (caller.role !== 'superuser') {
      throw new GraphQLError('Only superusers can import airports', {
        extensions: { code: 'FORBIDDEN' },
      });
    }

    // Parse CSV: icaoCode, name, city, country, latitude, longitude, iataCode
    const lines = args.csvData.split('\n').filter((l) => l.trim());
    let imported = 0;
    const errors: string[] = [];

    for (const line of lines) {
      const parts = line.split(',').map((p) => p.trim());
      if (parts.length < 7) {
        errors.push(`Skipped line (need 7 fields): ${line.slice(0, 50)}`);
        continue;
      }
      const [icaoCode, iataCode, name, city, country, lat, lng] = parts;
      if (!icaoCode || icaoCode.length !== 4) {
        errors.push(`Skipped invalid ICAO: ${icaoCode}`);
        continue;
      }

      try {
        await ctx.prisma.airport.upsert({
          where: { icaoCode },
          create: {
            icaoCode,
            iataCode: iataCode || null,
            name: name || 'Unknown',
            city: city || null,
            country: country || 'Unknown',
            latitude: parseFloat(lat) || 0,
            longitude: parseFloat(lng) || 0,
          },
          update: {
            iataCode: iataCode || null,
            name: name || 'Unknown',
            city: city || null,
            country: country || 'Unknown',
            latitude: parseFloat(lat) || 0,
            longitude: parseFloat(lng) || 0,
          },
        });
        imported++;
      } catch (e) {
        errors.push(`Failed to import ${icaoCode}: ${e instanceof Error ? e.message : String(e)}`);
      }
    }

    return { imported, errors: errors.slice(0, 50) };
  },

  adminImportAirlines: async (_parent: unknown, args: { csvData: string }, ctx: Context) => {
    const caller = await getDbUser(ctx);
    if (caller.role !== 'superuser') {
      throw new GraphQLError('Only superusers can import airlines', {
        extensions: { code: 'FORBIDDEN' },
      });
    }

    // Parse CSV: icaoCode,iataCode,name,country,callsign (5 fields)
    // IATA can be empty/null
    const lines = args.csvData.split('\n').filter((l) => l.trim());
    let imported = 0;
    const errors: string[] = [];

    for (const line of lines) {
      // Parse CSV properly handling quoted fields
      const fields = [];
      let current = '';
      let inQuotes = false;

      for (const char of line) {
        if (char === '"') {
          inQuotes = !inQuotes;
        } else if (char === ',' && !inQuotes) {
          fields.push(current.trim());
          current = '';
        } else {
          current += char;
        }
      }
      fields.push(current.trim());

      if (fields.length < 5) {
        errors.push(`Skipped line (need 5 fields): ${line.slice(0, 50)}`);
        continue;
      }

      const [icaoCode, iataCode, name, country, callsign] = fields;
      const cleanIcao = icaoCode?.replace(/\W/g, '').toUpperCase();
      const cleanIata = iataCode?.replace(/\W/g, '').toUpperCase() || null;

      if (!cleanIcao || cleanIcao.length < 2 || cleanIcao.length > 3) {
        errors.push(`Skipped invalid ICAO: ${icaoCode}`);
        continue;
      }

      try {
        // ICAO codes are not unique — match on (icaoCode, name) so we
        // update the matching row when re-importing, and create a new
        // airline when the same code appears with a new name.
        const existing = await ctx.prisma.airline.findFirst({
          where: {
            icaoCode: cleanIcao,
            name: { equals: name || 'Unknown', mode: 'insensitive' },
          },
        });

        if (existing) {
          await ctx.prisma.airline.update({
            where: { id: existing.id },
            data: {
              name: name || 'Unknown',
              iataCode: cleanIata || null,
              country: country || null,
              callsign: callsign || null,
            },
          });
        } else {
          await ctx.prisma.airline.create({
            data: {
              name: name || 'Unknown',
              icaoCode: cleanIcao,
              iataCode: cleanIata || null,
              country: country || null,
              callsign: callsign || null,
            },
          });
        }
        imported++;
      } catch (e) {
        errors.push(`Failed to import ${cleanIcao}: ${e instanceof Error ? e.message : String(e)}`);
      }
    }

    return { imported, errors: errors.slice(0, 50) };
  },

  adminImportAircraftHierarchy: async (
    _parent: unknown,
    args: { csvData: string },
    ctx: Context,
  ) => {
    const caller = await getDbUser(ctx);
    if (caller.role !== 'superuser') {
      throw new GraphQLError('Only superusers can import aircraft', {
        extensions: { code: 'FORBIDDEN' },
      });
    }

    // Parse pipe-delimited CSV: manufacturer|family|variant|iataCode|icaoCode
    const lines = args.csvData.split('\n').filter((l) => l.trim());
    let imported = 0;
    const errors: string[] = [];

    for (const line of lines) {
      const fields = line.split('|').map((p) => p.trim());
      if (fields.length < 3) {
        errors.push(`Skipped line (need 3 fields): ${line.slice(0, 50)}`);
        continue;
      }

      const [manufacturer, family, variant, iataCode, icaoCode] = fields;
      if (!manufacturer || !family || !variant) {
        errors.push(`Skipped line (missing required fields): ${line.slice(0, 50)}`);
        continue;
      }

      try {
        // Upsert manufacturer
        const mfr = await ctx.prisma.aircraftManufacturer.upsert({
          where: { name: manufacturer },
          create: { name: manufacturer, country: null },
          update: {},
        });

        // Upsert family — family name is unique per manufacturer, so look up
        // by (name, manufacturerId). Use findFirst + create/update to avoid
        // relying on a globally-unique `name` constraint.
        const existingFam = await ctx.prisma.aircraftFamily.findFirst({
          where: { name: family, manufacturerId: mfr.id },
        });
        const fam = existingFam
          ? await ctx.prisma.aircraftFamily.update({
              where: { id: existingFam.id },
              data: { manufacturerId: mfr.id },
            })
          : await ctx.prisma.aircraftFamily.create({
              data: { name: family, manufacturerId: mfr.id },
            });

        // Upsert variant with codes
        const cleanIata = iataCode?.replace(/\W/g, '').toUpperCase() || null;
        const cleanIcao = icaoCode?.replace(/\W/g, '').toUpperCase() || null;

        await ctx.prisma.aircraftVariant.upsert({
          where: { name: variant },
          create: {
            name: variant,
            familyId: fam.id,
            iataCode: cleanIata,
            icaoCode: cleanIcao,
          },
          update: {
            familyId: fam.id,
            iataCode: cleanIata,
            icaoCode: cleanIcao,
          },
        });

        imported++;
      } catch (e) {
        errors.push(
          `Failed to import ${manufacturer}/${family}/${variant}: ${
            e instanceof Error ? e.message : String(e)
          }`,
        );
      }
    }

    return { imported, errors: errors.slice(0, 50) };
  },
};
