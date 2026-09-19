import { GraphQLError } from 'graphql';

import type { Context } from '../context.js';
import { resolveUserId } from '../utils/resolverHelpers.js';

import { checkAndAwardBadges } from './badgeResolvers.js';
import { createNotification } from './notificationResolvers.js';

// ─── Types ──────────────────────────────────────────────────────────────────

export interface PhotoParent {
  id: string;
  userId: string;
}

// ─── Helpers ────────────────────────────────────────────────────────────────

const photoIncludes = { user: true, variants: true, tags: true } as const;

// ─── Mutation Resolvers ─────────────────────────────────────────────────────

export const likeMutationResolvers = {
  likePhoto: async (_parent: unknown, args: { photoId: string }, ctx: Context) => {
    const userId = await resolveUserId(ctx);

    // Verify photo exists
    const photo = await ctx.prisma.photo.findUnique({
      where: { id: args.photoId },
      select: { id: true },
    });
    if (!photo) {
      throw new GraphQLError('Photo not found', {
        extensions: { code: 'NOT_FOUND' },
      });
    }

    // Upsert-style: create if not already liked (idempotent).
    // Wrap in a transaction to prevent race-condition double-increment.
    await ctx.prisma.$transaction(async (tx) => {
      const existing = await tx.like.findUnique({
        where: { userId_photoId: { userId, photoId: args.photoId } },
      });
      if (!existing) {
        await tx.like.create({
          data: { userId, photoId: args.photoId },
        });
        await tx.photo.update({
          where: { id: args.photoId },
          data: { likeCount: { increment: 1 } },
        });
      }
    });

    // Notify the photo owner (skip self-likes)
    const [photoOwner, liker] = await Promise.all([
      ctx.prisma.photo.findUnique({ where: { id: args.photoId }, select: { userId: true } }),
      ctx.prisma.user.findUnique({ where: { id: userId }, select: { username: true } }),
    ]);
    if (photoOwner && liker && photoOwner.userId !== userId) {
      createNotification(ctx.prisma, {
        userId: photoOwner.userId,
        type: 'like',
        title: '❤️ New like',
        body: `@${liker.username} liked your photo`,
        data: { photoId: args.photoId },
      }).catch(() => {});
    }

    // Re-evaluate engagement badges on the photo owner. Fire-and-forget so
    // badge errors cannot break the like mutation.
    if (photoOwner) {
      checkAndAwardBadges(ctx, photoOwner.userId, 'like_received_count').catch(() => {});
    }

    // Clear cached like count so subsequent field resolvers see the updated value
    ctx.loaders.photoLikeCount.clear(args.photoId);

    return ctx.prisma.photo.findUnique({
      where: { id: args.photoId },
      include: photoIncludes,
    });
  },

  unlikePhoto: async (_parent: unknown, args: { photoId: string }, ctx: Context) => {
    const userId = await resolveUserId(ctx);

    // Verify photo exists
    const photo = await ctx.prisma.photo.findUnique({
      where: { id: args.photoId },
      select: { id: true },
    });
    if (!photo) {
      throw new GraphQLError('Photo not found', {
        extensions: { code: 'NOT_FOUND' },
      });
    }

    // Delete if exists, no-op if not (idempotent).
    // Wrap in a transaction to prevent race-condition double-decrement.
    await ctx.prisma.$transaction(async (tx) => {
      const result = await tx.like.deleteMany({
        where: { userId, photoId: args.photoId },
      });
      if (result.count > 0) {
        await tx.photo.update({
          where: { id: args.photoId },
          data: { likeCount: { decrement: 1 } },
        });
      }
      return result;
    });

    // Clear cached like count so subsequent field resolvers see the updated value
    ctx.loaders.photoLikeCount.clear(args.photoId);

    return ctx.prisma.photo.findUnique({
      where: { id: args.photoId },
      include: photoIncludes,
    });
  },
};

// ─── Field Resolvers ────────────────────────────────────────────────────────

export const likeFieldResolvers = {
  isLikedByMe: async (parent: PhotoParent, _args: unknown, ctx: Context) => {
    if (!ctx.user) return false;

    const user = await ctx.prisma.user.findUnique({
      where: { cognitoSub: ctx.user.sub },
      select: { id: true },
    });
    if (!user) return false;

    const like = await ctx.prisma.like.findUnique({
      where: { userId_photoId: { userId: user.id, photoId: parent.id } },
      select: { id: true },
    });
    return !!like;
  },
};
