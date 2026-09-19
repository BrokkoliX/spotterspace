import { Prisma } from '@spotterspace/db';
import { GraphQLError } from 'graphql';

import type { Context } from '../context.js';
import { encodeCursor, resolveUserId, buildPaginationArgs } from '../utils/resolverHelpers.js';

// ─── Types ───────────────────────────────────────────────────────────────────

type NotificationType =
  | 'like'
  | 'comment'
  | 'follow'
  | 'mention'
  | 'moderation'
  | 'system'
  | 'community_join'
  | 'community_event';

export interface NotificationParent {
  id: string;
  createdAt: Date;
}

export interface NotificationsArgs {
  first?: number;
  after?: string;
  page?: number;
  unreadOnly?: boolean;
}

// ─── Public helper: fire-and-forget notification creation ─────────────────────

/**
 * Creates a notification record. Silently swallows errors so notification
 * failures never break the triggering mutation.
 */
export async function createNotification(
  prisma: Context['prisma'],
  input: {
    userId: string;
    type: NotificationType;
    title: string;
    body?: string;
    data?: Record<string, unknown>;
  },
): Promise<void> {
  try {
    await prisma.notification.create({
      data: {
        userId: input.userId,
        type: input.type,
        title: input.title,
        body: input.body,
        data: (input.data ?? {}) as Prisma.InputJsonValue,
      },
    });
  } catch (err) {
    console.error('[createNotification] Failed to create notification:', err);
  }
}

// ─── Query Resolvers ──────────────────────────────────────────────────────────

export const notificationQueryResolvers = {
  notifications: async (_parent: unknown, args: NotificationsArgs, ctx: Context) => {
    const userId = await resolveUserId(ctx);
    const { skip, take, cursorWhere } = buildPaginationArgs({
      first: args.first,
      after: args.after,
      page: args.page,
    });

    const where: Record<string, unknown> = { userId };
    if (args.unreadOnly) where.isRead = false;
    if (cursorWhere) {
      Object.assign(where, cursorWhere);
    }

    const items = await ctx.prisma.notification.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      skip,
      take: take + 1,
    });

    const hasNextPage = items.length > take;
    const edges = items.slice(0, take).map((n) => ({
      cursor: encodeCursor(n.createdAt),
      node: n,
    }));

    return {
      edges,
      pageInfo: {
        hasNextPage,
        endCursor: edges.length > 0 ? edges[edges.length - 1].cursor : null,
      },
    };
  },

  unreadNotificationCount: async (_parent: unknown, _args: unknown, ctx: Context) => {
    if (!ctx.user) return 0;
    const user = await ctx.prisma.user.findUnique({
      where: { cognitoSub: ctx.user.sub },
      select: { id: true },
    });
    if (!user) return 0;
    return ctx.prisma.notification.count({
      where: { userId: user.id, isRead: false },
    });
  },
};

// ─── Mutation Resolvers ───────────────────────────────────────────────────────

export const notificationMutationResolvers = {
  markNotificationRead: async (_parent: unknown, args: { id: string }, ctx: Context) => {
    const userId = await resolveUserId(ctx);

    const notification = await ctx.prisma.notification.findUnique({
      where: { id: args.id },
    });
    if (!notification) {
      throw new GraphQLError('Notification not found', {
        extensions: { code: 'NOT_FOUND' },
      });
    }
    if (notification.userId !== userId) {
      throw new GraphQLError('Forbidden', {
        extensions: { code: 'FORBIDDEN' },
      });
    }

    return ctx.prisma.notification.update({
      where: { id: args.id },
      data: { isRead: true },
    });
  },

  markAllNotificationsRead: async (_parent: unknown, _args: unknown, ctx: Context) => {
    const userId = await resolveUserId(ctx);
    await ctx.prisma.notification.updateMany({
      where: { userId, isRead: false },
      data: { isRead: true },
    });
    return true;
  },

  deleteNotification: async (_parent: unknown, args: { id: string }, ctx: Context) => {
    const userId = await resolveUserId(ctx);

    const notification = await ctx.prisma.notification.findUnique({
      where: { id: args.id },
    });
    if (!notification) {
      throw new GraphQLError('Notification not found', {
        extensions: { code: 'NOT_FOUND' },
      });
    }
    if (notification.userId !== userId) {
      throw new GraphQLError('Forbidden', {
        extensions: { code: 'FORBIDDEN' },
      });
    }

    await ctx.prisma.notification.delete({ where: { id: args.id } });
    return true;
  },
};

// ─── Field Resolvers ──────────────────────────────────────────────────────────

export const notificationFieldResolvers = {
  createdAt: (parent: NotificationParent) => parent.createdAt.toISOString(),
  data: (parent: NotificationParent & { data?: unknown }) => parent.data ?? null,
};
