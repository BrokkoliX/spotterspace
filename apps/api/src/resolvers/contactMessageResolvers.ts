import { GraphQLError } from 'graphql';

import { requireAuth, requireRole } from '../auth/requireAuth.js';
import type { Context } from '../context.js';
import { encodeCursor, buildPaginationArgs } from '../utils/resolverHelpers.js';

// ─── Types ──────────────────────────────────────────────────────────────────

export interface CreateContactMessageInput {
  subject: string;
  body: string;
  email?: string;
}

// ─── Query Resolvers ────────────────────────────────────────────────────────

export const contactMessageQueryResolvers = {
  contactMessages: async (
    _parent: unknown,
    args: { status?: string; first?: number; after?: string; page?: number },
    ctx: Context,
  ) => {
    await requireRole(ctx, ['admin', 'moderator', 'superuser']);

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
      ctx.prisma.contactMessage.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip,
        take: take + 1,
        include: { user: { select: { id: true, username: true, email: true } } },
      }),
      ctx.prisma.contactMessage.count({ where }),
    ]);

    const hasNextPage = items.length > take;
    const edges = items.slice(0, take).map((msg) => ({
      cursor: encodeCursor(msg.createdAt),
      node: msg,
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

// ─── Mutation Resolvers ──────────────────────────────────────────────────────

export const contactMessageMutationResolvers = {
  createContactMessage: async (
    _parent: unknown,
    args: { input: CreateContactMessageInput },
    ctx: Context,
  ) => {
    const authUser = requireAuth(ctx);

    const user = await ctx.prisma.user.findUnique({
      where: { cognitoSub: authUser.sub },
      select: { id: true, email: true },
    });

    if (!user) {
      throw new GraphQLError('User not found', {
        extensions: { code: 'NOT_FOUND' },
      });
    }

    const { subject, body, email } = args.input;

    if (!subject.trim()) {
      throw new GraphQLError('Subject is required', {
        extensions: { code: 'BAD_USER_INPUT' },
      });
    }

    if (!body.trim() || body.trim().length < 10) {
      throw new GraphQLError('Message body must be at least 10 characters', {
        extensions: { code: 'BAD_USER_INPUT' },
      });
    }

    if (body.trim().length > 2000) {
      throw new GraphQLError('Message body must be at most 2000 characters', {
        extensions: { code: 'BAD_USER_INPUT' },
      });
    }

    const contactMessage = await ctx.prisma.contactMessage.create({
      data: {
        userId: user.id,
        email: email?.trim() || null,
        subject: subject.trim(),
        body: body.trim(),
      },
      include: { user: true },
    });

    return contactMessage;
  },

  reviewContactMessage: async (
    _parent: unknown,
    args: { id: string; status: string },
    ctx: Context,
  ) => {
    const authUser = await requireRole(ctx, ['admin', 'moderator', 'superuser']);

    const adminUser = await ctx.prisma.user.findUnique({
      where: { cognitoSub: authUser.sub },
      select: { id: true },
    });

    if (!adminUser) {
      throw new GraphQLError('User not found', {
        extensions: { code: 'NOT_FOUND' },
      });
    }

    const existing = await ctx.prisma.contactMessage.findUnique({
      where: { id: args.id },
      include: { user: true },
    });

    if (!existing) {
      throw new GraphQLError('Contact message not found', {
        extensions: { code: 'NOT_FOUND' },
      });
    }

    const updated = await ctx.prisma.contactMessage.update({
      where: { id: args.id },
      data: {
        status: args.status as 'read' | 'resolved',
        reviewedBy: adminUser.id,
        reviewedAt: new Date(),
      },
      include: { user: true },
    });

    // Notify the original user if they have an account
    if (updated.userId) {
      await ctx.prisma.notification.create({
        data: {
          userId: updated.userId,
          type: 'system',
          title: 'Contact message update',
          body:
            args.status === 'resolved'
              ? 'Your contact message has been resolved.'
              : 'Your contact message has been reviewed.',
          data: { contactMessageId: updated.id },
        },
      });
    }

    return updated;
  },
};

// ─── Field Resolvers ─────────────────────────────────────────────────────────

export const contactMessageFieldResolvers = {
  ContactMessage: {
    createdAt: (parent: { createdAt: Date }) => parent.createdAt.toISOString(),
    reviewedAt: (parent: { reviewedAt: Date | null }) => parent.reviewedAt?.toISOString() ?? null,
  },
};
