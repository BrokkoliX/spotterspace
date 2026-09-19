import { Prisma } from '@spotterspace/db';
import { GraphQLError } from 'graphql';

import { requireRole } from '../auth/requireAuth.js';
import type { Context } from '../context.js';
import { buildPaginationArgs } from '../utils/resolverHelpers.js';

// ─── Types ──────────────────────────────────────────────────────────────────

export interface AirportParent {
  id: string;
}

// ─── Query Resolvers ────────────────────────────────────────────────────────

export const airportQueryResolvers = {
  exportAirports: async (_parent: unknown, _args: unknown, ctx: Context) => {
    await requireRole(ctx, ['admin', 'superuser']);
    return ctx.prisma.airport.findMany({
      orderBy: { icaoCode: 'asc' },
    });
  },

  airports: async (
    _parent: unknown,
    args: { first?: number; after?: string; page?: number },
    ctx: Context,
  ) => {
    const { skip, take } = buildPaginationArgs({
      first: args.first,
      after: args.after,
      page: args.page,
    });
    const where: Record<string, unknown> = {};

    if (args.after) {
      where.id = { gt: args.after };
    }

    const [items, totalCount] = await Promise.all([
      ctx.prisma.airport.findMany({
        where,
        orderBy: { icaoCode: 'asc' },
        skip,
        take: take + 1,
      }),
      ctx.prisma.airport.count(),
    ]);

    const hasNextPage = items.length > take;
    const edges = items.map((airport) => ({
      cursor: airport.id,
      node: airport,
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

  airport: async (_parent: unknown, args: { code: string }, ctx: Context) => {
    const code = args.code.trim().toUpperCase();

    // Try ICAO first, then IATA
    const airport = await ctx.prisma.airport.findUnique({
      where: { icaoCode: code },
    });

    if (airport) return airport;

    return ctx.prisma.airport.findUnique({
      where: { iataCode: code },
    });
  },

  adminAirports: async (
    _parent: unknown,
    args: { search?: string; first?: number; after?: string; page?: number },
    ctx: Context,
  ) => {
    await requireRole(ctx, ['admin', 'superuser']);

    const { skip, take } = buildPaginationArgs({
      first: args.first,
      after: args.after,
      page: args.page,
    });
    const where: Record<string, unknown> = {};

    if (args.search) {
      const words = args.search.trim().split(/\s+/).filter(Boolean);
      where.AND = words.map((word) => ({
        OR: [
          { icaoCode: { contains: word, mode: 'insensitive' } },
          { iataCode: { contains: word, mode: 'insensitive' } },
          { name: { contains: word, mode: 'insensitive' } },
          { city: { contains: word, mode: 'insensitive' } },
          { country: { contains: word, mode: 'insensitive' } },
        ],
      }));
    }

    if (args.after) {
      where.id = { gt: args.after };
    }

    const [items, totalCount] = await Promise.all([
      ctx.prisma.airport.findMany({
        where,
        orderBy: { icaoCode: 'asc' },
        skip,
        take: take + 1,
      }),
      ctx.prisma.airport.count({ where }),
    ]);

    const hasNextPage = items.length > take;
    const edges = items.slice(0, take).map((airport) => ({
      cursor: airport.id,
      node: airport,
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

  searchAirports: async (
    _parent: unknown,
    args: { query: string; first?: number },
    ctx: Context,
  ) => {
    const q = args.query.trim();
    if (!q) return [];

    const take = Math.min(args.first ?? 8, 20);
    const words = q.split(/\s+/).filter(Boolean);

    const where = (
      words.length === 1
        ? {
            OR: [
              { icaoCode: { contains: words[0], mode: 'insensitive' } },
              { iataCode: { contains: words[0], mode: 'insensitive' } },
              { name: { contains: words[0], mode: 'insensitive' } },
              { city: { contains: words[0], mode: 'insensitive' } },
            ],
          }
        : {
            AND: words.map((word) => ({
              OR: [
                { icaoCode: { contains: word, mode: 'insensitive' } },
                { iataCode: { contains: word, mode: 'insensitive' } },
                { name: { contains: word, mode: 'insensitive' } },
                { city: { contains: word, mode: 'insensitive' } },
              ],
            })),
          }
    ) as Prisma.AirportWhereInput;

    return ctx.prisma.airport.findMany({
      where,
      select: {
        icaoCode: true,
        iataCode: true,
        name: true,
        city: true,
        country: true,
        latitude: true,
        longitude: true,
      },
      orderBy: { icaoCode: 'asc' },
      take,
    });
  },

  airportsInBounds: async (
    _parent: unknown,
    args: {
      swLat: number;
      swLng: number;
      neLat: number;
      neLng: number;
      first?: number;
    },
    ctx: Context,
  ) => {
    const take = Math.min(args.first ?? 2000, 2000);

    // When the viewport crosses the antimeridian (e.g. Pacific-centred map
    // pan), Mapbox returns sw.lng > ne.lng. In that case we OR two halves:
    // [sw.lng, 180] ∪ [-180, ne.lng]. Otherwise, plain BETWEEN is correct.
    const crossesAntimeridian = args.swLng > args.neLng;
    const lngWhere = crossesAntimeridian
      ? {
          OR: [
            { longitude: { gte: args.swLng, lte: 180 } },
            { longitude: { gte: -180, lte: args.neLng } },
          ],
        }
      : { longitude: { gte: args.swLng, lte: args.neLng } };

    return ctx.prisma.airport.findMany({
      where: {
        latitude: { gte: args.swLat, lte: args.neLat },
        ...lngWhere,
      },
      select: {
        id: true,
        icaoCode: true,
        iataCode: true,
        name: true,
        city: true,
        country: true,
        latitude: true,
        longitude: true,
      },
      orderBy: { icaoCode: 'asc' },
      take,
    });
  },
};

// ─── Field Resolvers ────────────────────────────────────────────────────────

export const airportFieldResolvers = {
  photoCount: async (parent: AirportParent, _args: unknown, ctx: Context) => {
    return ctx.prisma.photoLocation.count({
      where: { airportId: parent.id, photo: { isDeleted: false, moderationStatus: 'approved' } },
    });
  },

  spottingLocations: async (parent: AirportParent, _args: unknown, ctx: Context) => {
    return ctx.prisma.spottingLocation.findMany({
      where: { airportId: parent.id },
      include: { createdBy: { include: { profile: true } } },
      orderBy: { name: 'asc' },
    });
  },
};

// ─── Airport Mutation Resolvers ─────────────────────────────────────────────

export const airportMutationResolvers = {
  createAirport: async (
    _parent: unknown,
    args: {
      input: {
        icaoCode: string;
        iataCode?: string;
        name: string;
        city?: string;
        country?: string;
        latitude: number;
        longitude: number;
      };
    },
    ctx: Context,
  ) => {
    await requireRole(ctx, ['admin', 'superuser']);

    return ctx.prisma.airport.create({
      data: {
        icaoCode: args.input.icaoCode.toUpperCase(),
        iataCode: args.input.iataCode?.toUpperCase(),
        name: args.input.name,
        city: args.input.city,
        country: args.input.country,
        latitude: args.input.latitude,
        longitude: args.input.longitude,
      },
    });
  },

  updateAirport: async (
    _parent: unknown,
    args: {
      id: string;
      input: {
        icaoCode?: string;
        iataCode?: string;
        name?: string;
        city?: string;
        country?: string;
        latitude?: number;
        longitude?: number;
      };
    },
    ctx: Context,
  ) => {
    await requireRole(ctx, ['admin', 'superuser']);

    const existing = await ctx.prisma.airport.findUnique({
      where: { id: args.id },
    });
    if (!existing) {
      throw new GraphQLError('Airport not found', {
        extensions: { code: 'NOT_FOUND' },
      });
    }

    return ctx.prisma.airport.update({
      where: { id: args.id },
      data: {
        ...(args.input.icaoCode !== undefined && {
          icaoCode: args.input.icaoCode.toUpperCase(),
        }),
        ...(args.input.iataCode !== undefined && {
          iataCode: args.input.iataCode?.toUpperCase(),
        }),
        ...(args.input.name !== undefined && { name: args.input.name }),
        ...(args.input.city !== undefined && { city: args.input.city }),
        ...(args.input.country !== undefined && { country: args.input.country }),
        ...(args.input.latitude !== undefined && { latitude: args.input.latitude }),
        ...(args.input.longitude !== undefined && { longitude: args.input.longitude }),
      },
    });
  },

  deleteAirport: async (_parent: unknown, args: { id: string }, ctx: Context) => {
    await requireRole(ctx, ['admin', 'superuser']);

    const existing = await ctx.prisma.airport.findUnique({
      where: { id: args.id },
    });
    if (!existing) {
      throw new GraphQLError('Airport not found', {
        extensions: { code: 'NOT_FOUND' },
      });
    }

    await ctx.prisma.airport.delete({ where: { id: args.id } });
    return true;
  },

  upsertAirport: async (
    _parent: unknown,
    args: {
      input: {
        icaoCode: string;
        iataCode?: string;
        name: string;
        city?: string;
        country?: string;
        latitude: number;
        longitude: number;
      };
    },
    ctx: Context,
  ) => {
    await requireRole(ctx, ['admin', 'superuser']);

    const icao = args.input.icaoCode.toUpperCase();
    const existing = await ctx.prisma.airport.findUnique({
      where: { icaoCode: icao },
    });

    if (existing) {
      return ctx.prisma.airport.update({
        where: { id: existing.id },
        data: {
          iataCode: args.input.iataCode?.toUpperCase() ?? existing.iataCode,
          name: args.input.name,
          city: args.input.city ?? existing.city,
          country: args.input.country ?? existing.country,
          latitude: args.input.latitude,
          longitude: args.input.longitude,
        },
      });
    }

    return ctx.prisma.airport.create({
      data: {
        icaoCode: icao,
        iataCode: args.input.iataCode?.toUpperCase(),
        name: args.input.name,
        city: args.input.city,
        country: args.input.country,
        latitude: args.input.latitude,
        longitude: args.input.longitude,
      },
    });
  },
};
