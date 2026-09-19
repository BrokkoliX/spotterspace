import '@spotterspace/db';
import { GraphQLError } from 'graphql';

import { requireAuth, requireRole } from '../auth/requireAuth.js';
import type { Context } from '../context.js';
import { generateVariants } from '../services/imageProcessing.js';
import { decodeCursor, encodeCursor } from '../utils/resolverHelpers.js';

import { createNotification } from './notificationResolvers.js';

function parseDecimal(value: unknown): string {
  if (!value) return '0';
  if (typeof value === 'string') return value;
  if (typeof value === 'number') return value.toFixed(2);
  return String(value);
}

// ─── Query Resolvers ────────────────────────────────────────────────────────

export const marketplaceCollectiblesQueryResolvers = {
  marketplaceItems: async (
    _parent: unknown,
    args: {
      category?: string;
      minPrice?: number;
      maxPrice?: number;
      condition?: string;
      search?: string;
      sortBy?: string;
      first?: number;
      after?: string;
    },
    ctx: Context,
  ) => {
    const take = Math.min(args.first ?? 20, 50);

    const where: Record<string, unknown> = {
      moderationStatus: 'approved',
      active: true,
    };

    if (args.category) {
      where.categoryId = args.category;
    }

    if (args.minPrice !== undefined || args.maxPrice !== undefined) {
      where.priceUsd = {};
      if (args.minPrice !== undefined) {
        (where.priceUsd as Record<string, unknown>).gte = args.minPrice;
      }
      if (args.maxPrice !== undefined) {
        (where.priceUsd as Record<string, unknown>).lte = args.maxPrice;
      }
    }

    if (args.condition) {
      where.condition = args.condition;
    }

    if (args.search) {
      where.OR = [
        { title: { contains: args.search, mode: 'insensitive' } },
        { description: { contains: args.search, mode: 'insensitive' } },
      ];
    }

    // Only approved sellers
    where.seller = { status: 'approved' };

    let orderBy: Record<string, unknown> = { createdAt: 'desc' };
    if (args.sortBy === 'price_asc') {
      orderBy = { priceUsd: 'asc' };
    } else if (args.sortBy === 'price_desc') {
      orderBy = { priceUsd: 'desc' };
    } else if (args.sortBy === 'rating_desc') {
      orderBy = { feedback: { _count: 'desc' } };
    }

    const paginateWhere = args.after
      ? { ...where, createdAt: { lt: decodeCursor(args.after) } }
      : where;

    const [items, totalCount] = await Promise.all([
      ctx.prisma.marketplaceItem.findMany({
        where: paginateWhere,
        orderBy,
        take: take + 1,
        include: {
          seller: { include: { user: { include: { profile: true } } } },
          category: true,
          images: { orderBy: { sortOrder: 'asc' } },
        },
      }),
      ctx.prisma.marketplaceItem.count({ where }),
    ]);

    const hasNextPage = items.length > take;
    const edges = items.slice(0, take).map((item) => ({
      cursor: encodeCursor(item.createdAt),
      node: item,
    }));

    return {
      edges,
      pageInfo: {
        hasNextPage,
        endCursor: hasNextPage ? edges[edges.length - 1].cursor : null,
      },
      totalCount,
    };
  },

  marketplaceItem: async (_parent: unknown, args: { id: string }, ctx: Context) => {
    return ctx.prisma.marketplaceItem.findUnique({
      where: { id: args.id },
      include: {
        seller: { include: { user: { include: { profile: true } } } },
        category: true,
        images: { orderBy: { sortOrder: 'asc' } },
      },
    });
  },

  marketplaceCategories: async (_parent: unknown, _args: unknown, ctx: Context) => {
    return ctx.prisma.marketplaceCategory.findMany({
      orderBy: { sortOrder: 'asc' },
    });
  },

  sellerProfile: async (_parent: unknown, args: { userId: string }, ctx: Context) => {
    return ctx.prisma.sellerProfile.findUnique({
      where: { userId: args.userId },
      include: { user: { include: { profile: true } } },
    });
  },

  sellerFeedback: async (
    _parent: unknown,
    args: { sellerId: string; first?: number; after?: string },
    ctx: Context,
  ) => {
    const take = Math.min(args.first ?? 20, 50);

    const paginateWhere = args.after
      ? { sellerId: args.sellerId, createdAt: { lt: decodeCursor(args.after) } }
      : { sellerId: args.sellerId };

    const [feedback, totalCount] = await Promise.all([
      ctx.prisma.sellerFeedback.findMany({
        where: paginateWhere,
        orderBy: { createdAt: 'desc' },
        take: take + 1,
        include: {
          buyer: { include: { profile: true } },
          item: true,
        },
      }),
      ctx.prisma.sellerFeedback.count({ where: { sellerId: args.sellerId } }),
    ]);

    const hasNextPage = feedback.length > take;
    const edges = feedback.slice(0, take).map((f) => ({
      cursor: encodeCursor(f.createdAt),
      node: f,
    }));

    return {
      edges,
      pageInfo: {
        hasNextPage,
        endCursor: hasNextPage ? edges[edges.length - 1].cursor : null,
      },
      totalCount,
    };
  },

  myListings: async (_parent: unknown, args: { first?: number; after?: string }, ctx: Context) => {
    const authUser = requireAuth(ctx);
    const take = Math.min(args.first ?? 20, 50);

    const user = await ctx.prisma.user.findUnique({ where: { cognitoSub: authUser.sub } });
    if (!user) throw new GraphQLError('User not found');

    const sellerProfile = await ctx.prisma.sellerProfile.findUnique({ where: { userId: user.id } });
    if (!sellerProfile) throw new GraphQLError('Seller profile not found');

    const paginateWhere = args.after
      ? { sellerId: sellerProfile.id, createdAt: { lt: decodeCursor(args.after) } }
      : { sellerId: sellerProfile.id };

    const [items, totalCount] = await Promise.all([
      ctx.prisma.marketplaceItem.findMany({
        where: paginateWhere,
        orderBy: { createdAt: 'desc' },
        take: take + 1,
        include: {
          category: true,
          images: { orderBy: { sortOrder: 'asc' } },
        },
      }),
      ctx.prisma.marketplaceItem.count({ where: { sellerId: sellerProfile.id } }),
    ]);

    const hasNextPage = items.length > take;
    const edges = items.slice(0, take).map((item) => ({
      cursor: encodeCursor(item.createdAt),
      node: item,
    }));

    return {
      edges,
      pageInfo: {
        hasNextPage,
        endCursor: hasNextPage ? edges[edges.length - 1].cursor : null,
      },
      totalCount,
    };
  },

  adminMarketplaceItems: async (
    _parent: unknown,
    args: { moderationStatus?: string; first?: number; after?: string },
    ctx: Context,
  ) => {
    requireRole(ctx, ['admin', 'superuser', 'moderator']);
    const take = Math.min(args.first ?? 20, 50);

    const where: Record<string, unknown> = {};
    if (args.moderationStatus) {
      where.moderationStatus = args.moderationStatus;
    }

    const paginateWhere = args.after
      ? { ...where, createdAt: { lt: decodeCursor(args.after) } }
      : where;

    const [items, totalCount] = await Promise.all([
      ctx.prisma.marketplaceItem.findMany({
        where: paginateWhere,
        orderBy: { createdAt: 'desc' },
        take: take + 1,
        include: {
          seller: { include: { user: { include: { profile: true } } } },
          category: true,
          images: { orderBy: { sortOrder: 'asc' } },
        },
      }),
      ctx.prisma.marketplaceItem.count({ where }),
    ]);

    const hasNextPage = items.length > take;
    const edges = items.slice(0, take).map((item) => ({
      cursor: encodeCursor(item.createdAt),
      node: item,
    }));

    return {
      edges,
      pageInfo: {
        hasNextPage,
        endCursor: hasNextPage ? edges[edges.length - 1].cursor : null,
      },
      totalCount,
    };
  },
};

// ─── Mutation Resolvers ─────────────────────────────────────────────────────

export const marketplaceCollectiblesMutationResolvers = {
  updateSellerStatus: async (
    _parent: unknown,
    args: { sellerProfileId: string; status: string },
    ctx: Context,
  ) => {
    requireRole(ctx, ['admin', 'superuser']);

    const profile = await ctx.prisma.sellerProfile.findUnique({
      where: { id: args.sellerProfileId },
      include: { user: { include: { profile: true } } },
    });
    if (!profile) throw new GraphQLError('Seller profile not found');

    const approved = args.status === 'approved';
    return ctx.prisma.sellerProfile.update({
      where: { id: args.sellerProfileId },
      data: {
        status: args.status as 'pending' | 'approved' | 'rejected',
        approved,
      },
      include: { user: { include: { profile: true } } },
    });
  },

  createMarketplaceItem: async (
    _parent: unknown,
    args: {
      input: {
        categoryId: string;
        title: string;
        description?: string | null;
        priceUsd: unknown;
        condition: string;
        location?: string | null;
        contactEmail?: string | null;
        contactPhone?: string | null;
        imageS3Keys: string[];
      };
    },
    ctx: Context,
  ) => {
    const authUser = requireAuth(ctx);

    const user = await ctx.prisma.user.findUnique({ where: { cognitoSub: authUser.sub } });
    if (!user) throw new GraphQLError('User not found');

    const sellerProfile = await ctx.prisma.sellerProfile.findUnique({ where: { userId: user.id } });
    if (!sellerProfile) throw new GraphQLError('No seller profile found');
    if (sellerProfile.status !== 'approved') {
      throw new GraphQLError('Your seller account must be approved to create listings');
    }

    const category = await ctx.prisma.marketplaceCategory.findUnique({
      where: { id: args.input.categoryId },
    });
    if (!category) throw new GraphQLError('Category not found');

    const item = await ctx.prisma.marketplaceItem.create({
      data: {
        sellerId: sellerProfile.id,
        userId: user.id,
        categoryId: args.input.categoryId,
        title: args.input.title,
        description: args.input.description ?? null,
        priceUsd: String(args.input.priceUsd),
        condition: args.input.condition,
        location: args.input.location ?? null,
        contactEmail: args.input.contactEmail ?? null,
        contactPhone: args.input.contactPhone ?? null,
        moderationStatus: 'pending',
        active: false,
      },
      include: {
        seller: { include: { user: { include: { profile: true } } } },
        category: true,
        images: true,
      },
    });

    // Process images: generate variants for each S3 key
    for (let i = 0; i < args.input.imageS3Keys.length; i++) {
      const s3Key = args.input.imageS3Keys[i];
      try {
        const variants = await generateVariants(s3Key);

        for (const variant of variants) {
          await ctx.prisma.marketplaceItemImage.create({
            data: {
              itemId: item.id,
              variantType: variant.variantType,
              url: variant.url,
              width: variant.width,
              height: variant.height,
              fileSizeBytes: variant.fileSizeBytes,
              sortOrder: i,
            },
          });
        }
      } catch (err) {
        console.error(`Failed to process image variant for key ${s3Key}:`, err);
      }
    }

    // Refetch with images
    return ctx.prisma.marketplaceItem.findUnique({
      where: { id: item.id },
      include: {
        seller: { include: { user: { include: { profile: true } } } },
        category: true,
        images: { orderBy: { sortOrder: 'asc' } },
      },
    });
  },

  updateMarketplaceItem: async (
    _parent: unknown,
    args: {
      id: string;
      input: {
        categoryId?: string;
        title?: string;
        description?: string | null;
        priceUsd?: unknown;
        condition?: string;
        location?: string | null;
        contactEmail?: string | null;
        contactPhone?: string | null;
        imageS3Keys?: string[];
        active?: boolean;
      };
    },
    ctx: Context,
  ) => {
    const authUser = requireAuth(ctx);

    const user = await ctx.prisma.user.findUnique({ where: { cognitoSub: authUser.sub } });
    if (!user) throw new GraphQLError('User not found');

    const sellerProfile = await ctx.prisma.sellerProfile.findUnique({ where: { userId: user.id } });
    if (!sellerProfile) throw new GraphQLError('No seller profile found');

    const item = await ctx.prisma.marketplaceItem.findUnique({ where: { id: args.id } });
    if (!item) throw new GraphQLError('Item not found');
    if (item.sellerId !== sellerProfile.id) {
      throw new GraphQLError('Not your listing');
    }

    const updateData: Record<string, unknown> = {};
    if (args.input.categoryId !== undefined) updateData.categoryId = args.input.categoryId;
    if (args.input.title !== undefined) updateData.title = args.input.title;
    if (args.input.description !== undefined) updateData.description = args.input.description;
    if (args.input.priceUsd !== undefined) updateData.priceUsd = String(args.input.priceUsd);
    if (args.input.condition !== undefined) updateData.condition = args.input.condition;
    if (args.input.location !== undefined) updateData.location = args.input.location;
    if (args.input.contactEmail !== undefined) updateData.contactEmail = args.input.contactEmail;
    if (args.input.contactPhone !== undefined) updateData.contactPhone = args.input.contactPhone;
    if (args.input.active !== undefined) updateData.active = args.input.active;

    const updated = await ctx.prisma.marketplaceItem.update({
      where: { id: args.id },
      data: updateData,
      include: {
        seller: { include: { user: { include: { profile: true } } } },
        category: true,
        images: { orderBy: { sortOrder: 'asc' } },
      },
    });

    // If new image keys provided, append new variants
    if (args.input.imageS3Keys && args.input.imageS3Keys.length > 0) {
      const existingCount = await ctx.prisma.marketplaceItemImage.count({
        where: { itemId: args.id },
      });

      for (let i = 0; i < args.input.imageS3Keys.length; i++) {
        const s3Key = args.input.imageS3Keys[i];
        try {
          const variants = await generateVariants(s3Key);
          for (const variant of variants) {
            await ctx.prisma.marketplaceItemImage.create({
              data: {
                itemId: args.id,
                variantType: variant.variantType,
                url: variant.url,
                width: variant.width,
                height: variant.height,
                fileSizeBytes: variant.fileSizeBytes,
                sortOrder: existingCount + i,
              },
            });
          }
        } catch (err) {
          console.error(`Failed to process image variant for key ${s3Key}:`, err);
        }
      }
    }

    return updated;
  },

  deleteMarketplaceItem: async (_parent: unknown, args: { id: string }, ctx: Context) => {
    const authUser = requireAuth(ctx);

    const user = await ctx.prisma.user.findUnique({ where: { cognitoSub: authUser.sub } });
    if (!user) throw new GraphQLError('User not found');

    const sellerProfile = await ctx.prisma.sellerProfile.findUnique({ where: { userId: user.id } });
    if (!sellerProfile) throw new GraphQLError('No seller profile found');

    const item = await ctx.prisma.marketplaceItem.findUnique({ where: { id: args.id } });
    if (!item) throw new GraphQLError('Item not found');
    if (item.sellerId !== sellerProfile.id) {
      throw new GraphQLError('Not your listing');
    }

    await ctx.prisma.marketplaceItem.delete({ where: { id: args.id } });
    return true;
  },

  moderateMarketplaceItem: async (
    _parent: unknown,
    args: { id: string; status: string; reason?: string },
    ctx: Context,
  ) => {
    requireRole(ctx, ['admin', 'superuser', 'moderator']);

    const item = await ctx.prisma.marketplaceItem.findUnique({ where: { id: args.id } });
    if (!item) throw new GraphQLError('Item not found');

    const updateData: Record<string, unknown> = {
      moderationStatus: args.status,
    };

    if (args.status === 'rejected' && args.reason) {
      updateData.moderationReason = args.reason;
    }

    if (args.status === 'approved') {
      updateData.active = true;
    }

    const updated = await ctx.prisma.marketplaceItem.update({
      where: { id: args.id },
      data: updateData,
      include: {
        seller: { include: { user: { include: { profile: true } } } },
        category: true,
        images: { orderBy: { sortOrder: 'asc' } },
      },
    });

    // Notify the seller on rejection. Mirrors rejectPhoto in photoResolvers.ts:
    // awaited so the moderation message is guaranteed to be persisted before
    // the mutation returns; createNotification swallows internal errors.
    if (args.status === 'rejected') {
      await createNotification(ctx.prisma, {
        userId: item.userId,
        type: 'moderation',
        title: '🚫 Listing rejected',
        body: args.reason
          ? `Your listing "${item.title}" was rejected: ${args.reason}`
          : `Your listing "${item.title}" was rejected by a moderator.`,
        data: { marketplaceItemId: item.id, reason: args.reason ?? null },
      });
    }

    return updated;
  },

  submitSellerFeedback: async (
    _parent: unknown,
    args: {
      input: { sellerId: string; rating: number; comment?: string | null; itemId?: string | null };
    },
    ctx: Context,
  ) => {
    const authUser = requireAuth(ctx);

    if (args.input.rating < 1 || args.input.rating > 5) {
      throw new GraphQLError('Rating must be between 1 and 5');
    }

    const user = await ctx.prisma.user.findUnique({ where: { cognitoSub: authUser.sub } });
    if (!user) throw new GraphQLError('User not found');

    const sellerProfile = await ctx.prisma.sellerProfile.findUnique({
      where: { id: args.input.sellerId },
    });
    if (!sellerProfile) throw new GraphQLError('Seller not found');

    // One feedback per buyer per seller
    const existing = await ctx.prisma.sellerFeedback.findUnique({
      where: { buyerId_sellerId: { buyerId: user.id, sellerId: args.input.sellerId } },
    });
    if (existing) throw new GraphQLError('You have already submitted feedback for this seller');

    return ctx.prisma.sellerFeedback.create({
      data: {
        sellerId: args.input.sellerId,
        buyerId: user.id,
        rating: args.input.rating,
        comment: args.input.comment ?? null,
        itemId: args.input.itemId ?? null,
      },
      include: {
        buyer: { include: { profile: true } },
        item: true,
      },
    });
  },

  getMarketplaceItemUploadUrl: async (
    _parent: unknown,
    args: { input: { mimeType: string; fileSizeBytes: number } },
    ctx: Context,
  ) => {
    requireAuth(ctx);
    const { getPresignedUploadUrl } = await import('../services/s3.js');
    const result = await getPresignedUploadUrl('marketplace', args.input.mimeType);
    return { url: result.url, key: result.key };
  },

  createMarketplaceCategory: async (
    _parent: unknown,
    args: { input: { name: string; label: string; sortOrder?: number } },
    ctx: Context,
  ) => {
    requireRole(ctx, ['admin', 'superuser']);

    const existing = await ctx.prisma.marketplaceCategory.findUnique({
      where: { name: args.input.name },
    });
    if (existing) throw new GraphQLError('Category with this name already exists');

    return ctx.prisma.marketplaceCategory.create({
      data: {
        name: args.input.name,
        label: args.input.label,
        sortOrder: args.input.sortOrder ?? 0,
      },
    });
  },

  updateMarketplaceCategory: async (
    _parent: unknown,
    args: { id: string; input: { name?: string; label?: string; sortOrder?: number } },
    ctx: Context,
  ) => {
    requireRole(ctx, ['admin', 'superuser']);

    const category = await ctx.prisma.marketplaceCategory.findUnique({
      where: { id: args.id },
    });
    if (!category) throw new GraphQLError('Category not found');

    return ctx.prisma.marketplaceCategory.update({
      where: { id: args.id },
      data: {
        name: args.input.name ?? category.name,
        label: args.input.label ?? category.label,
        sortOrder: args.input.sortOrder ?? category.sortOrder,
      },
    });
  },

  deleteMarketplaceCategory: async (_parent: unknown, args: { id: string }, ctx: Context) => {
    requireRole(ctx, ['admin', 'superuser']);

    const itemCount = await ctx.prisma.marketplaceItem.count({
      where: { categoryId: args.id },
    });
    if (itemCount > 0) {
      throw new GraphQLError('Cannot delete category with existing items');
    }

    await ctx.prisma.marketplaceCategory.delete({ where: { id: args.id } });
    return true;
  },
};

// ─── Field Resolvers ────────────────────────────────────────────────────────

export const marketplaceItemFieldResolvers = {
  priceUsd: (parent: { priceUsd: unknown }) => parseDecimal(parent.priceUsd),
  averageRating: async (parent: { sellerId: string }, _args: unknown, ctx: Context) => {
    const agg = await ctx.prisma.sellerFeedback.aggregate({
      where: { sellerId: parent.sellerId },
      _avg: { rating: true },
    });
    return agg._avg.rating ?? 0;
  },
  feedbackCount: async (parent: { sellerId: string }, _args: unknown, ctx: Context) => {
    return ctx.prisma.sellerFeedback.count({ where: { sellerId: parent.sellerId } });
  },
  createdAt: (parent: { createdAt: Date }) => parent.createdAt.toISOString(),
  updatedAt: (parent: { updatedAt: Date }) => parent.updatedAt.toISOString(),
};

export const marketplaceItemImageFieldResolvers = {
  createdAt: (parent: { createdAt: Date }) => parent.createdAt.toISOString(),
};

export const sellerFeedbackFieldResolvers = {
  createdAt: (parent: { createdAt: Date }) => parent.createdAt.toISOString(),
};

export const marketplaceCategoryFieldResolvers = {
  itemCount: async (parent: { id: string }, _args: unknown, ctx: Context) => {
    return ctx.prisma.marketplaceItem.count({
      where: { categoryId: parent.id, moderationStatus: 'approved', active: true },
    });
  },
};

export const sellerProfileCollectiblesFieldResolvers = {
  averageRating: async (parent: { id: string }, _args: unknown, ctx: Context) => {
    const agg = await ctx.prisma.sellerFeedback.aggregate({
      where: { sellerId: parent.id },
      _avg: { rating: true },
    });
    return agg._avg.rating ?? 0;
  },
  feedbackCount: async (parent: { id: string }, _args: unknown, ctx: Context) => {
    return ctx.prisma.sellerFeedback.count({ where: { sellerId: parent.id } });
  },
  status: (parent: { status: string }) => parent.status,
  createdAt: (parent: { createdAt: Date }) => parent.createdAt.toISOString(),
  updatedAt: (parent: { updatedAt: Date }) => parent.updatedAt.toISOString(),
};
