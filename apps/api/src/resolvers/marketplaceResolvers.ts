import '@spotterspace/db';
import { GraphQLError } from 'graphql';

import { requireAuth, requireRole } from '../auth/requireAuth.js';
import type { Context } from '../context.js';
import {
  createConnectAccount,
  createAccountOnboardingLink,
  createCheckoutSession,
} from '../services/stripe.js';
import { buildPaginationArgs } from '../utils/resolverHelpers.js';

// ─── Helpers ────────────────────────────────────────────────────────────────

function parseDecimal(value: unknown): string {
  if (!value) return '0';
  if (typeof value === 'string') return value;
  if (typeof value === 'number') return value.toFixed(2);
  return String(value);
}

// ─── Query Resolvers ────────────────────────────────────────────────────────

export const marketplaceQueryResolvers = {
  marketplaceListings: async (
    _parent: unknown,
    args: { first?: number; after?: string; sortBy?: string },
    ctx: Context,
  ) => {
    const take = Math.min(args.first ?? 20, 50);

    // Only approved photos with active listings
    const where = {
      hasActiveListing: true,
      moderationStatus: 'approved' as const,
      listing: { active: true },
    };

    const orderBy =
      args.sortBy === 'price_asc'
        ? { listing: { priceUsd: 'asc' as const } }
        : args.sortBy === 'price_desc'
          ? { listing: { priceUsd: 'desc' as const } }
          : { createdAt: 'desc' as const };

    if (args.after) {
      const cursorPhoto = await ctx.prisma.photo.findUnique({ where: { id: args.after } });
      if (cursorPhoto) {
        if (args.sortBy === 'price_asc' || args.sortBy === 'price_desc') {
          // For price sorting, use createdAt as secondary order field for cursor
          Object.assign(where, { createdAt: { lt: cursorPhoto.createdAt } });
        } else {
          Object.assign(where, { createdAt: { lt: cursorPhoto.createdAt } });
        }
      }
    }

    const [photos, totalCount] = await Promise.all([
      ctx.prisma.photo.findMany({
        where,
        orderBy,
        take: take + 1,
        include: {
          user: { include: { profile: true } },
          variants: true,
          listing: true,
          aircraft: { include: { manufacturer: true, family: true, variant: true } },
        },
      }),
      ctx.prisma.photo.count({ where }),
    ]);

    const hasNextPage = photos.length > take;
    const edges = photos.slice(0, take).map((p) => ({ cursor: p.id, node: p }));

    return {
      edges,
      pageInfo: { hasNextPage, endCursor: hasNextPage ? edges[edges.length - 1].cursor : null },
      totalCount,
    };
  },

  myPurchases: async (
    _parent: unknown,
    args: { first?: number; after?: string; page?: number },
    ctx: Context,
  ) => {
    const authUser = requireAuth(ctx);
    const { skip, take, cursorWhere } = buildPaginationArgs({
      first: args.first,
      after: args.after,
      page: args.page,
    });

    const user = await ctx.prisma.user.findUnique({ where: { cognitoSub: authUser.sub } });
    if (!user) throw new GraphQLError('User not found');

    const paginateWhere: Record<string, unknown> = { buyerId: user.id };
    if (cursorWhere) {
      Object.assign(paginateWhere, cursorWhere);
    }

    const [orders, totalCount] = await Promise.all([
      ctx.prisma.order.findMany({
        where: paginateWhere,
        orderBy: { createdAt: 'desc' },
        skip,
        take: take + 1,
        include: {
          buyer: { include: { profile: true } },
          seller: { include: { profile: true } },
          photo: {
            include: {
              user: { include: { profile: true } },
              variants: true,
              aircraft: { include: { manufacturer: true, family: true, variant: true } },
            },
          },
          listing: true,
        },
      }),
      ctx.prisma.order.count({ where: { buyerId: user.id } }),
    ]);

    const hasNextPage = orders.length > take;
    const edges = orders.slice(0, take).map((o) => ({ cursor: o.id, node: o }));

    return {
      edges,
      pageInfo: { hasNextPage, endCursor: hasNextPage ? edges[edges.length - 1].cursor : null },
      totalCount,
    };
  },

  mySales: async (
    _parent: unknown,
    args: { first?: number; after?: string; page?: number },
    ctx: Context,
  ) => {
    const authUser = requireAuth(ctx);
    const { skip, take, cursorWhere } = buildPaginationArgs({
      first: args.first,
      after: args.after,
      page: args.page,
    });

    const user = await ctx.prisma.user.findUnique({ where: { cognitoSub: authUser.sub } });
    if (!user) throw new GraphQLError('User not found');

    const paginateWhere: Record<string, unknown> = { sellerId: user.id };
    if (cursorWhere) {
      Object.assign(paginateWhere, cursorWhere);
    }

    const [orders, totalCount] = await Promise.all([
      ctx.prisma.order.findMany({
        where: paginateWhere,
        orderBy: { createdAt: 'desc' },
        skip,
        take: take + 1,
        include: {
          buyer: { include: { profile: true } },
          seller: { include: { profile: true } },
          photo: {
            include: {
              user: { include: { profile: true } },
              variants: true,
              aircraft: { include: { manufacturer: true, family: true, variant: true } },
            },
          },
          listing: true,
        },
      }),
      ctx.prisma.order.count({ where: { sellerId: user.id } }),
    ]);

    const hasNextPage = orders.length > take;
    const edges = orders.slice(0, take).map((o) => ({ cursor: o.id, node: o }));

    return {
      edges,
      pageInfo: { hasNextPage, endCursor: hasNextPage ? edges[edges.length - 1].cursor : null },
      totalCount,
    };
  },

  adminSellerApplications: async (
    _parent: unknown,
    args: { first?: number; after?: string; status?: string; page?: number },
    ctx: Context,
  ) => {
    requireRole(ctx, ['admin', 'superuser']);
    const { skip, take, cursorWhere } = buildPaginationArgs({
      first: args.first,
      after: args.after,
      page: args.page,
    });

    const where: Record<string, unknown> = {};
    if (args.status) where.status = args.status;
    if (cursorWhere) {
      Object.assign(where, cursorWhere);
    }
    // Always exclude already-approved sellers from the pending list
    where.approved = false;

    const [applications, totalCount] = await Promise.all([
      ctx.prisma.sellerProfile.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip,
        take: take + 1,
        include: { user: { include: { profile: true } } },
      }),
      ctx.prisma.sellerProfile.count({ where }),
    ]);

    const hasNextPage = applications.length > take;
    const edges = applications.slice(0, take).map((a) => ({ cursor: a.id, node: a }));

    return {
      edges,
      pageInfo: { hasNextPage, endCursor: hasNextPage ? edges[edges.length - 1].cursor : null },
      totalCount,
    };
  },
};

// ─── Mutation Resolvers ─────────────────────────────────────────────────────

export const marketplaceMutationResolvers = {
  applyToSell: async (
    _parent: unknown,
    args: { input: { bio: string; website?: string | null } },
    ctx: Context,
  ) => {
    const authUser = requireAuth(ctx);

    const user = await ctx.prisma.user.findUnique({ where: { cognitoSub: authUser.sub } });
    if (!user) throw new GraphQLError('User not found');

    const existing = await ctx.prisma.sellerProfile.findUnique({ where: { userId: user.id } });
    if (existing) throw new GraphQLError('You already have a seller profile');

    return ctx.prisma.sellerProfile.create({
      data: {
        userId: user.id,
        bio: args.input.bio,
        website: args.input.website ?? null,
        approved: false,
        stripeOnboardingComplete: false,
      },
      include: { user: { include: { profile: true } } },
    });
  },

  approveSeller: async (_parent: unknown, args: { sellerProfileId: string }, ctx: Context) => {
    requireRole(ctx, ['admin', 'superuser']);

    const profile = await ctx.prisma.sellerProfile.findUnique({
      where: { id: args.sellerProfileId },
      include: { user: true },
    });
    if (!profile) throw new GraphQLError('Seller profile not found');
    if (profile.approved) throw new GraphQLError('Seller already approved');

    let stripeAccountId: string | null = null;
    let onboardingUrl = '';

    if (profile.user.email) {
      try {
        stripeAccountId = await createConnectAccount(profile.user.email, profile.user.id);
      } catch (err) {
        console.error('Failed to create Stripe Connect account (non-fatal):', err);
        // Non-fatal: proceed with approval even if Stripe account creation fails
      }
    }

    if (stripeAccountId) {
      const appUrl = process.env.APP_URL ?? 'http://localhost:3000';
      const returnUrl = `${appUrl}/settings/seller?onboarding=complete`;
      const refreshUrl = `${appUrl}/settings/seller?onboarding=refresh`;
      try {
        onboardingUrl = await createAccountOnboardingLink(stripeAccountId, returnUrl, refreshUrl);
      } catch (err) {
        console.error('Failed to create Stripe onboarding link (non-fatal):', err);
        // Non-fatal: seller is still approved, just no onboarding URL returned
      }
    }

    const updated = await ctx.prisma.sellerProfile.update({
      where: { id: args.sellerProfileId },
      data: {
        approved: true,
        status: 'approved',
        // Only update Stripe fields when Stripe account creation succeeded
        ...(stripeAccountId != null && { stripeAccountId }),
        // Only set stripeOnboardingComplete: false when we have a new Stripe account
        // (meaning onboarding is NOT yet complete — seller must still complete Stripe onboarding).
        // If stripeAccountId is null, leave stripeOnboardingComplete unchanged to preserve
        // any prior state (existing account may already be onboarded).
        ...(stripeAccountId != null && { stripeOnboardingComplete: false }),
      },
      include: { user: { include: { profile: true } } },
    });

    return { sellerProfile: updated, onboardingUrl };
  },

  createOrUpdateListing: async (
    _parent: unknown,
    args: { input: { photoId: string; priceUsd: number | string; active: boolean } },
    ctx: Context,
  ) => {
    const authUser = requireAuth(ctx);

    const user = await ctx.prisma.user.findUnique({ where: { cognitoSub: authUser.sub } });
    if (!user) throw new GraphQLError('User not found');

    const sellerProfile = await ctx.prisma.sellerProfile.findUnique({ where: { userId: user.id } });
    if (!sellerProfile?.approved) {
      throw new GraphQLError('You must be an approved seller to create listings');
    }

    const photo = await ctx.prisma.photo.findUnique({ where: { id: args.input.photoId } });
    if (!photo) throw new GraphQLError('Photo not found');
    if (photo.userId !== user.id) throw new GraphQLError('Not your photo');
    if (photo.moderationStatus !== 'approved') {
      throw new GraphQLError('Photo must be approved before listing for sale');
    }

    // Upsert: try update first, then create
    const existing = await ctx.prisma.photoListing.findUnique({
      where: { photoId: args.input.photoId },
    });

    const listing = existing
      ? await ctx.prisma.photoListing.update({
          where: { photoId: args.input.photoId },
          data: { priceUsd: String(args.input.priceUsd), active: args.input.active },
          include: { photo: { include: { user: { include: { profile: true } }, variants: true } } },
        })
      : await ctx.prisma.photoListing.create({
          data: {
            photoId: args.input.photoId,
            sellerId: user.id,
            priceUsd: String(args.input.priceUsd),
            active: args.input.active,
          },
          include: { photo: { include: { user: { include: { profile: true } }, variants: true } } },
        });

    await ctx.prisma.photo.update({
      where: { id: args.input.photoId },
      data: { hasActiveListing: args.input.active },
    });

    return listing;
  },

  removeListing: async (_parent: unknown, args: { photoId: string }, ctx: Context) => {
    const authUser = requireAuth(ctx);

    const user = await ctx.prisma.user.findUnique({ where: { cognitoSub: authUser.sub } });
    if (!user) throw new GraphQLError('User not found');

    const photo = await ctx.prisma.photo.findUnique({ where: { id: args.photoId } });
    if (!photo) throw new GraphQLError('Photo not found');
    if (photo.userId !== user.id) throw new GraphQLError('Not your photo');

    await ctx.prisma.photoListing.deleteMany({ where: { photoId: args.photoId } });

    await ctx.prisma.photo.update({
      where: { id: args.photoId },
      data: { hasActiveListing: false },
    });

    return true;
  },

  createPhotoPurchase: async (_parent: unknown, args: { listingId: string }, ctx: Context) => {
    const authUser = requireAuth(ctx);

    const user = await ctx.prisma.user.findUnique({ where: { cognitoSub: authUser.sub } });
    if (!user) throw new GraphQLError('User not found');

    const listing = await ctx.prisma.photoListing.findUnique({
      where: { id: args.listingId },
      include: { photo: true },
    });
    if (!listing) throw new GraphQLError('Listing not found');
    if (!listing.active) throw new GraphQLError('Listing is not active');
    if (listing.photo.userId === user.id) throw new GraphQLError('Cannot buy your own photo');

    const sellerProfile = await ctx.prisma.sellerProfile.findUnique({
      where: { userId: listing.sellerId },
    });

    const platformFeePercent = parseInt(process.env.PLATFORM_FEE_PERCENT ?? '20', 10);
    const priceUsd = Number(listing.priceUsd);
    const platformFeeUsd = priceUsd * (platformFeePercent / 100);

    const order = await ctx.prisma.order.create({
      data: {
        buyerId: user.id,
        sellerId: listing.sellerId,
        photoId: listing.photoId,
        listingId: listing.id,
        amountUsd: listing.priceUsd,
        platformFeeUsd,
        status: 'pending',
      },
    });

    const appUrl = process.env.APP_URL ?? 'http://localhost:3000';
    const successUrl = `${appUrl}/settings/purchases?purchase=success&orderId=${order.id}`;
    const cancelUrl = `${appUrl}/photos/${listing.photoId}?purchase=cancelled`;

    try {
      const { sessionId, checkoutUrl } = await createCheckoutSession({
        listing: {
          id: listing.id,
          priceUsd,
          sellerStripeAccountId: sellerProfile?.stripeAccountId ?? null,
        },
        buyerEmail: user.email,
        orderId: order.id,
        successUrl,
        cancelUrl,
      });

      await ctx.prisma.order.update({
        where: { id: order.id },
        data: { stripePaymentIntentId: sessionId },
      });

      return { sessionId, checkoutUrl };
    } catch (err) {
      await ctx.prisma.order.update({
        where: { id: order.id },
        data: { status: 'failed' },
      });
      throw err;
    }
  },
};

// ─── Field Resolvers ────────────────────────────────────────────────────────

export const photoListingFieldResolvers = {
  priceUsd: (parent: { priceUsd: unknown }) => parseDecimal(parent.priceUsd),
  createdAt: (parent: { createdAt: Date }) => parent.createdAt.toISOString(),
  updatedAt: (parent: { updatedAt: Date }) => parent.updatedAt.toISOString(),
};

export const orderFieldResolvers = {
  amountUsd: (parent: { amountUsd: unknown }) => parseDecimal(parent.amountUsd),
  platformFeeUsd: (parent: { platformFeeUsd: unknown }) => parseDecimal(parent.platformFeeUsd),
  createdAt: (parent: { createdAt: Date }) => parent.createdAt.toISOString(),
};

export const sellerProfileFieldResolvers = {
  createdAt: (parent: { createdAt: Date }) => parent.createdAt.toISOString(),
  updatedAt: (parent: { updatedAt: Date }) => parent.updatedAt.toISOString(),
};
