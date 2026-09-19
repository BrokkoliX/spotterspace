import { randomBytes } from 'node:crypto';

import { GraphQLError } from 'graphql';

import type { Context } from '../context.js';
import {
  decodeCursor,
  encodeCursor,
  getDbUser,
  buildPaginationArgs,
} from '../utils/resolverHelpers.js';
import { validateStringLength, validateSlug } from '../utils/validation.js';

import { checkAndAwardBadges } from './badgeResolvers.js';
import { createNotification } from './notificationResolvers.js';

// ─── Types ──────────────────────────────────────────────────────────────────

export interface CommunityParent {
  id: string;
  ownerId: string;
}

export interface CommunityMemberParent {
  id: string;
  communityId: string;
  userId: string;
}

export interface CreateCommunityInput {
  name: string;
  slug: string;
  description?: string | null;
  category?: string | null;
  visibility?: string | null;
  location?: string | null;
}

export interface UpdateCommunityInput {
  name?: string | null;
  slug?: string | null;
  description?: string | null;
  category?: string | null;
  visibility?: string | null;
  location?: string | null;
  bannerUrl?: string | null;
  avatarUrl?: string | null;
}

// ─── Helpers ────────────────────────────────────────────────────────────────

const SLUG_RE = /^[a-z0-9][a-z0-9-]{1,48}[a-z0-9]$/;
const VALID_VISIBILITIES = ['public', 'invite_only'];
const COMMUNITY_ROLES = ['owner', 'admin', 'moderator', 'member'] as const;
type CommunityRoleType = (typeof COMMUNITY_ROLES)[number];

/** Numeric role weight — higher = more power. */
function roleWeight(role: string): number {
  const weights: Record<string, number> = { owner: 4, admin: 3, moderator: 2, member: 1 };
  return weights[role] ?? 0;
}

/** Get the caller's membership in a community. Returns null if not a member. */
async function getMembership(ctx: Context, communityId: string, userId: string) {
  return ctx.prisma.communityMember.findUnique({
    where: { communityId_userId: { communityId, userId } },
  });
}

function generateInviteCodeString(): string {
  return randomBytes(6).toString('hex'); // 12 chars
}

/** Check if a user can moderate a community (owner, admin, or moderator role). */
async function canModerate(
  ctx: Context,
  communityId: string,
  userId: string,
): Promise<{ role: string } | null> {
  const membership = await ctx.prisma.communityMember.findUnique({
    where: { communityId_userId: { communityId, userId } },
    select: { role: true, status: true },
  });
  if (!membership || membership.status !== 'active') return null;
  if (roleWeight(membership.role) < roleWeight('moderator')) return null;
  return { role: membership.role };
}

/** Log a moderation action to CommunityModerationLog. */
async function logModerationAction(
  ctx: Context,
  params: {
    communityId: string;
    moderatorId: string;
    targetUserId: string;
    action:
      | 'ban'
      | 'unban'
      | 'kick'
      | 'pin_thread'
      | 'unpin_thread'
      | 'lock_thread'
      | 'unlock_thread'
      | 'delete_post'
      | 'delete_photo'
      | 'delete_comment';
    reason?: string;
    metadata?: Record<string, unknown>;
  },
): Promise<void> {
  await ctx.prisma.communityModerationLog.create({
    data: {
      communityId: params.communityId,
      moderatorId: params.moderatorId,
      targetUserId: params.targetUserId,
      action: params.action,
      reason: params.reason ?? undefined,
      metadata: params.metadata as any,
    },
  });
}

// ─── Query Resolvers ────────────────────────────────────────────────────────

export const communityQueryResolvers = {
  community: async (_parent: unknown, args: { slug: string }, ctx: Context) => {
    return ctx.prisma.community.findUnique({ where: { slug: args.slug } });
  },

  communities: async (
    _parent: unknown,
    args: {
      search?: string;
      category?: string;
      first?: number;
      after?: string;
      page?: number;
      sort?: 'recent' | 'popular';
    },
    ctx: Context,
  ) => {
    const { skip, take, cursorWhere } = buildPaginationArgs({
      first: args.first,
      after: args.after,
      page: args.page,
    });
    const where: Record<string, unknown> = { visibility: 'public' };

    if (args.category) {
      where.category = args.category;
    }
    if (args.search) {
      where.OR = [
        { name: { contains: args.search, mode: 'insensitive' } },
        { description: { contains: args.search, mode: 'insensitive' } },
      ];
    }
    if (cursorWhere) {
      Object.assign(where, cursorWhere);
    }

    // Sort selection. 'recent' (default, also what every existing caller
    // gets implicitly) sorts by createdAt desc. 'popular' sorts by the
    // count of active members desc, with createdAt desc as a tiebreaker
    // — this keeps the order deterministic for ties while still letting
    // the cursor pagination (which is keyed on createdAt) work for
    // callers that want to paginate.
    const sort = args.sort ?? 'recent';
    const orderBy =
      sort === 'popular'
        ? [{ members: { _count: 'desc' as const } }, { createdAt: 'desc' as const }]
        : { createdAt: 'desc' as const };

    const [items, totalCount] = await Promise.all([
      ctx.prisma.community.findMany({
        where,
        orderBy,
        skip,
        take: take + 1,
      }),
      ctx.prisma.community.count({ where }),
    ]);

    const hasNextPage = items.length > take;
    const edges = items.slice(0, take).map((c) => ({
      cursor: encodeCursor(c.createdAt),
      node: c,
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

  myCommunities: async (_parent: unknown, _args: unknown, ctx: Context) => {
    const dbUser = await getDbUser(ctx);
    const memberships = await ctx.prisma.communityMember.findMany({
      where: { userId: dbUser.id, status: 'active' },
      include: { community: true },
      orderBy: { joinedAt: 'desc' },
    });
    return memberships.map((m) => m.community);
  },

  communityMembers: async (
    _parent: unknown,
    args: {
      communityId: string;
      filter?: {
        search?: string;
        role?: string[];
        status?: string[];
        first?: number;
        after?: string;
      };
    },
    ctx: Context,
  ) => {
    const dbUser = await getDbUser(ctx);
    const isSuperuser = dbUser.role === 'superuser';

    // Verify caller is admin/owner
    const callerMembership = await getMembership(ctx, args.communityId, dbUser.id);
    if (
      !isSuperuser &&
      (!callerMembership || !['owner', 'admin'].includes(callerMembership.role))
    ) {
      throw new GraphQLError('Only community owners and admins can view the member list', {
        extensions: { code: 'FORBIDDEN' },
      });
    }

    const take = Math.min(args.filter?.first ?? 50, 100);
    const where: Record<string, unknown> = { communityId: args.communityId };

    if (args.filter?.search) {
      const search = args.filter.search;
      where.user = {
        OR: [
          { username: { contains: search, mode: 'insensitive' } },
          { profile: { displayName: { contains: search, mode: 'insensitive' } } },
        ],
      };
    }

    if (args.filter?.role && args.filter.role.length > 0) {
      where.role = { in: args.filter.role };
    }

    if (args.filter?.status && args.filter.status.length > 0) {
      where.status = { in: args.filter.status };
    } else {
      // Default: show active + banned members
      where.status = { in: ['active', 'banned'] };
    }

    if (args.filter?.after) {
      const cursorMember = await ctx.prisma.communityMember.findUnique({
        where: { id: args.filter.after },
      });
      if (cursorMember) {
        where.joinedAt = { lt: cursorMember.joinedAt };
      }
    }

    const [items, totalCount] = await Promise.all([
      ctx.prisma.communityMember.findMany({
        where,
        orderBy: { joinedAt: 'desc' },
        take: take + 1,
      }),
      ctx.prisma.communityMember.count({ where }),
    ]);

    const hasNextPage = items.length > take;
    const edges = items.slice(0, take).map((m) => ({
      cursor: m.id,
      node: m,
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

export const communityMutationResolvers = {
  createCommunity: async (
    _parent: unknown,
    args: { input: CreateCommunityInput },
    ctx: Context,
  ) => {
    const dbUser = await getDbUser(ctx);
    const { name, slug, description, category, visibility, location } = args.input;
    validateStringLength(name, 'Community name', 3, 100);
    validateSlug(slug, 'Community slug');
    validateStringLength(description, 'Description', 0, 2000);

    // Validate name
    if (!name || name.trim().length < 3 || name.trim().length > 100) {
      throw new GraphQLError('Community name must be 3–100 characters', {
        extensions: { code: 'BAD_USER_INPUT' },
      });
    }

    // Validate slug
    if (!SLUG_RE.test(slug)) {
      throw new GraphQLError(
        'Slug must be 3–50 characters, lowercase alphanumeric and hyphens only, cannot start/end with a hyphen',
        { extensions: { code: 'BAD_USER_INPUT' } },
      );
    }

    // Check slug uniqueness
    const existing = await ctx.prisma.community.findUnique({ where: { slug } });
    if (existing) {
      throw new GraphQLError('A community with this slug already exists', {
        extensions: { code: 'BAD_USER_INPUT' },
      });
    }

    // Validate visibility
    const vis = visibility ?? 'public';
    if (!VALID_VISIBILITIES.includes(vis)) {
      throw new GraphQLError(`Visibility must be one of: ${VALID_VISIBILITIES.join(', ')}`, {
        extensions: { code: 'BAD_USER_INPUT' },
      });
    }

    // Create community + owner membership in a transaction
    const community = await ctx.prisma.$transaction(async (tx) => {
      const comm = await tx.community.create({
        data: {
          name: name.trim(),
          slug,
          description: description?.trim() ?? null,
          category: category ?? null,
          visibility: vis as 'public' | 'invite_only',
          location: location?.trim() ?? null,
          ownerId: dbUser.id,
          inviteCode: vis === 'invite_only' ? generateInviteCodeString() : null,
        },
      });

      // Auto-add creator as owner member
      await tx.communityMember.create({
        data: {
          communityId: comm.id,
          userId: dbUser.id,
          role: 'owner',
          status: 'active',
        },
      });

      return comm;
    });

    // Re-evaluate community badges on the creator. createCommunity also
    // auto-adds the owner as a member, so both metrics may have advanced.
    checkAndAwardBadges(ctx, dbUser.id, 'community_created_count').catch(() => {});
    checkAndAwardBadges(ctx, dbUser.id, 'community_join_count').catch(() => {});

    return community;
  },

  updateCommunity: async (
    _parent: unknown,
    args: { id: string; input: UpdateCommunityInput },
    ctx: Context,
  ) => {
    const dbUser = await getDbUser(ctx);
    const community = await ctx.prisma.community.findUnique({ where: { id: args.id } });
    if (!community) {
      throw new GraphQLError('Community not found', { extensions: { code: 'NOT_FOUND' } });
    }

    // Check permission: owner or admin or superuser
    const isSuperuser = dbUser.role === 'superuser';
    const membership = await getMembership(ctx, args.id, dbUser.id);
    if (!isSuperuser && (!membership || !['owner', 'admin'].includes(membership.role))) {
      throw new GraphQLError('Only community owners and admins can update community details', {
        extensions: { code: 'FORBIDDEN' },
      });
    }

    if (args.input.name) validateStringLength(args.input.name, 'Community name', 3, 100);
    if (args.input.slug) validateSlug(args.input.slug, 'Community slug');
    if (args.input.description)
      validateStringLength(args.input.description, 'Description', 0, 2000);

    const { slug, visibility, ...rest } = args.input;
    const data: Record<string, unknown> = {};

    // Copy non-null fields
    for (const [key, value] of Object.entries(rest)) {
      if (value !== undefined && value !== null) {
        data[key] = typeof value === 'string' ? value.trim() : value;
      }
    }

    // Validate slug change
    if (slug && slug !== community.slug) {
      if (!SLUG_RE.test(slug)) {
        throw new GraphQLError(
          'Slug must be 3–50 characters, lowercase alphanumeric and hyphens only',
          { extensions: { code: 'BAD_USER_INPUT' } },
        );
      }
      const existing = await ctx.prisma.community.findUnique({ where: { slug } });
      if (existing) {
        throw new GraphQLError('A community with this slug already exists', {
          extensions: { code: 'BAD_USER_INPUT' },
        });
      }
      data.slug = slug;
    }

    // Validate visibility change
    if (visibility && visibility !== community.visibility) {
      if (!VALID_VISIBILITIES.includes(visibility)) {
        throw new GraphQLError(`Visibility must be one of: ${VALID_VISIBILITIES.join(', ')}`, {
          extensions: { code: 'BAD_USER_INPUT' },
        });
      }
      data.visibility = visibility as 'public' | 'invite_only';
      // Auto-generate invite code when switching to invite_only
      if (visibility === 'invite_only' && !community.inviteCode) {
        data.inviteCode = generateInviteCodeString();
      }
    }

    return ctx.prisma.community.update({ where: { id: args.id }, data });
  },

  deleteCommunity: async (_parent: unknown, args: { id: string }, ctx: Context) => {
    const dbUser = await getDbUser(ctx);
    const community = await ctx.prisma.community.findUnique({ where: { id: args.id } });
    if (!community) {
      throw new GraphQLError('Community not found', { extensions: { code: 'NOT_FOUND' } });
    }

    if (community.ownerId !== dbUser.id) {
      throw new GraphQLError('Only the community owner can delete a community', {
        extensions: { code: 'FORBIDDEN' },
      });
    }

    await ctx.prisma.community.delete({ where: { id: args.id } });
    return true;
  },

  joinCommunity: async (
    _parent: unknown,
    args: { communityId: string; inviteCode?: string },
    ctx: Context,
  ) => {
    const dbUser = await getDbUser(ctx);
    const community = await ctx.prisma.community.findUnique({ where: { id: args.communityId } });
    if (!community) {
      throw new GraphQLError('Community not found', { extensions: { code: 'NOT_FOUND' } });
    }

    // Check for existing membership
    const existing = await getMembership(ctx, args.communityId, dbUser.id);
    if (existing) {
      if (existing.status === 'banned') {
        throw new GraphQLError('You have been banned from this community', {
          extensions: { code: 'FORBIDDEN' },
        });
      }
      if (existing.status === 'active') {
        throw new GraphQLError('You are already a member of this community', {
          extensions: { code: 'BAD_USER_INPUT' },
        });
      }
    }

    // Invite-only check
    if (community.visibility === 'invite_only') {
      if (!args.inviteCode || args.inviteCode !== community.inviteCode) {
        throw new GraphQLError('Invalid or missing invite code', {
          extensions: { code: 'FORBIDDEN' },
        });
      }
    }

    // Create or update membership
    let member;
    if (existing) {
      member = await ctx.prisma.communityMember.update({
        where: { id: existing.id },
        data: { status: 'active', role: 'member' },
      });
    } else {
      member = await ctx.prisma.communityMember.create({
        data: {
          communityId: args.communityId,
          userId: dbUser.id,
          role: 'member',
          status: 'active',
        },
      });
    }

    // Notify the community owner (skip if joiner is the owner)
    if (community.ownerId !== dbUser.id) {
      const joiner = await ctx.prisma.user.findUnique({
        where: { id: dbUser.id },
        select: { username: true },
      });
      if (joiner) {
        createNotification(ctx.prisma, {
          userId: community.ownerId,
          type: 'community_join',
          title: '🏘️ New member',
          body: `@${joiner.username} joined ${community.name}`,
          data: { communityId: args.communityId, userId: dbUser.id },
        }).catch(() => {});
      }
    }

    // Re-evaluate community badges on the joiner. Fire-and-forget so badge
    // errors cannot break the join mutation.
    checkAndAwardBadges(ctx, dbUser.id, 'community_join_count').catch(() => {});

    return member;
  },

  leaveCommunity: async (_parent: unknown, args: { communityId: string }, ctx: Context) => {
    const dbUser = await getDbUser(ctx);
    const membership = await getMembership(ctx, args.communityId, dbUser.id);
    if (!membership) {
      throw new GraphQLError('You are not a member of this community', {
        extensions: { code: 'BAD_USER_INPUT' },
      });
    }

    if (membership.role === 'owner') {
      throw new GraphQLError(
        'Owners cannot leave their community. Transfer ownership or delete the community.',
        { extensions: { code: 'FORBIDDEN' } },
      );
    }

    await ctx.prisma.communityMember.delete({ where: { id: membership.id } });
    return true;
  },

  removeCommunityMember: async (
    _parent: unknown,
    args: { communityId: string; userId: string },
    ctx: Context,
  ) => {
    const dbUser = await getDbUser(ctx);
    const isSuperuser = dbUser.role === 'superuser';

    // Get caller's membership
    const callerMembership = await getMembership(ctx, args.communityId, dbUser.id);
    if (
      !isSuperuser &&
      (!callerMembership || !['owner', 'admin', 'moderator'].includes(callerMembership.role))
    ) {
      throw new GraphQLError('You do not have permission to remove members', {
        extensions: { code: 'FORBIDDEN' },
      });
    }

    // Get target's membership
    const targetMembership = await getMembership(ctx, args.communityId, args.userId);
    if (!targetMembership) {
      throw new GraphQLError('User is not a member of this community', {
        extensions: { code: 'NOT_FOUND' },
      });
    }

    // Superuser can remove anyone; otherwise cannot remove someone with equal or higher role
    if (!isSuperuser && roleWeight(targetMembership.role) >= roleWeight(callerMembership!.role)) {
      throw new GraphQLError('Cannot remove a member with equal or higher role', {
        extensions: { code: 'FORBIDDEN' },
      });
    }

    await ctx.prisma.communityMember.delete({ where: { id: targetMembership.id } });
    return true;
  },

  updateCommunityMemberRole: async (
    _parent: unknown,
    args: { communityId: string; userId: string; role: string },
    ctx: Context,
  ) => {
    const dbUser = await getDbUser(ctx);
    const isSuperuser = dbUser.role === 'superuser';
    const newRole = args.role as CommunityRoleType;

    if (!COMMUNITY_ROLES.includes(newRole) || newRole === 'owner') {
      throw new GraphQLError(`Invalid role. Must be one of: admin, moderator, member`, {
        extensions: { code: 'BAD_USER_INPUT' },
      });
    }

    // Caller must be owner or admin or superuser
    const callerMembership = await getMembership(ctx, args.communityId, dbUser.id);
    if (
      !isSuperuser &&
      (!callerMembership || !['owner', 'admin'].includes(callerMembership.role))
    ) {
      throw new GraphQLError('Only owners and admins can change member roles', {
        extensions: { code: 'FORBIDDEN' },
      });
    }

    // Cannot promote above own role (superuser bypasses this)
    if (!isSuperuser && roleWeight(newRole) >= roleWeight(callerMembership!.role)) {
      throw new GraphQLError('Cannot assign a role equal to or higher than your own', {
        extensions: { code: 'FORBIDDEN' },
      });
    }

    const targetMembership = await getMembership(ctx, args.communityId, args.userId);
    if (!targetMembership) {
      throw new GraphQLError('User is not a member of this community', {
        extensions: { code: 'NOT_FOUND' },
      });
    }

    // Cannot change role of someone with equal or higher role (superuser bypasses this)
    if (!isSuperuser && roleWeight(targetMembership.role) >= roleWeight(callerMembership!.role)) {
      throw new GraphQLError('Cannot change the role of a member with equal or higher role', {
        extensions: { code: 'FORBIDDEN' },
      });
    }

    return ctx.prisma.communityMember.update({
      where: { id: targetMembership.id },
      data: { role: newRole },
    });
  },

  transferCommunityOwnership: async (
    _parent: unknown,
    args: { communityId: string; userId: string },
    ctx: Context,
  ) => {
    const dbUser = await getDbUser(ctx);
    const community = await ctx.prisma.community.findUnique({ where: { id: args.communityId } });
    if (!community) {
      throw new GraphQLError('Community not found', { extensions: { code: 'NOT_FOUND' } });
    }

    // Only current owner can transfer
    if (community.ownerId !== dbUser.id) {
      throw new GraphQLError('Only the community owner can transfer ownership', {
        extensions: { code: 'FORBIDDEN' },
      });
    }

    // Target must be an active member of the community
    const targetMembership = await getMembership(ctx, args.communityId, args.userId);
    if (!targetMembership || targetMembership.status !== 'active') {
      throw new GraphQLError('Target user is not an active member of this community', {
        extensions: { code: 'BAD_USER_INPUT' },
      });
    }

    // Cannot transfer to self
    if (args.userId === dbUser.id) {
      throw new GraphQLError('Cannot transfer ownership to yourself', {
        extensions: { code: 'BAD_USER_INPUT' },
      });
    }

    // Transfer ownership in a transaction: update ownerId, demote old owner to admin
    await ctx.prisma.$transaction([
      ctx.prisma.community.update({
        where: { id: args.communityId },
        data: { ownerId: args.userId },
      }),
      ctx.prisma.communityMember.update({
        where: { id: targetMembership.id },
        data: { role: 'owner' },
      }),
      // Demote old owner to admin (they were the owner, now become admin)
      ctx.prisma.communityMember.update({
        where: { communityId_userId: { communityId: args.communityId, userId: dbUser.id } },
        data: { role: 'admin' },
      }),
    ]);

    return ctx.prisma.community.findUnique({ where: { id: args.communityId } });
  },

  generateInviteCode: async (_parent: unknown, args: { communityId: string }, ctx: Context) => {
    const dbUser = await getDbUser(ctx);
    const isSuperuser = dbUser.role === 'superuser';
    const membership = await getMembership(ctx, args.communityId, dbUser.id);

    if (!isSuperuser && (!membership || !['owner', 'admin'].includes(membership.role))) {
      throw new GraphQLError('Only owners and admins can manage invite codes', {
        extensions: { code: 'FORBIDDEN' },
      });
    }

    return ctx.prisma.community.update({
      where: { id: args.communityId },
      data: { inviteCode: generateInviteCodeString() },
    });
  },

  deleteCommunityPhoto: async (
    _parent: unknown,
    args: { communityId: string; photoId: string; reason?: string },
    ctx: Context,
  ) => {
    const dbUser = await getDbUser(ctx);

    // Check moderator access
    const mod = await canModerate(ctx, args.communityId, dbUser.id);
    if (!mod && dbUser.role !== 'superuser') {
      throw new GraphQLError('You do not have permission to delete this photo', {
        extensions: { code: 'FORBIDDEN' },
      });
    }

    // Verify photo exists and belongs to a community album in this community
    const photo = await ctx.prisma.photo.findUnique({
      where: { id: args.photoId },
      select: { userId: true, albumId: true },
    });
    if (!photo) {
      throw new GraphQLError('Photo not found', { extensions: { code: 'NOT_FOUND' } });
    }

    if (photo.albumId) {
      const album = await ctx.prisma.album.findUnique({
        where: { id: photo.albumId },
        select: { communityId: true },
      });
      if (album?.communityId !== args.communityId) {
        throw new GraphQLError('Photo not found in this community', {
          extensions: { code: 'NOT_FOUND' },
        });
      }
    } else {
      throw new GraphQLError('Photo not found in this community', {
        extensions: { code: 'NOT_FOUND' },
      });
    }

    await logModerationAction(ctx, {
      communityId: args.communityId,
      moderatorId: dbUser.id,
      targetUserId: photo.userId,
      action: 'delete_photo',
      reason: args.reason,
      metadata: { photoId: args.photoId },
    });

    await ctx.prisma.photo.delete({ where: { id: args.photoId } });
    return true;
  },

  deleteCommunityComment: async (
    _parent: unknown,
    args: { communityId: string; commentId: string; reason?: string },
    ctx: Context,
  ) => {
    const dbUser = await getDbUser(ctx);

    const mod = await canModerate(ctx, args.communityId, dbUser.id);
    if (!mod && dbUser.role !== 'superuser') {
      throw new GraphQLError('You do not have permission to delete this comment', {
        extensions: { code: 'FORBIDDEN' },
      });
    }

    // Verify comment exists and belongs to a photo in this community
    const comment = await ctx.prisma.comment.findUnique({
      where: { id: args.commentId },
      select: { userId: true, photoId: true },
    });
    if (!comment) {
      throw new GraphQLError('Comment not found', { extensions: { code: 'NOT_FOUND' } });
    }

    if (comment.photoId) {
      const photo = await ctx.prisma.photo.findUnique({
        where: { id: comment.photoId },
        select: { albumId: true },
      });
      if (photo?.albumId) {
        const album = await ctx.prisma.album.findUnique({
          where: { id: photo.albumId },
          select: { communityId: true },
        });
        if (album?.communityId !== args.communityId) {
          throw new GraphQLError('Comment not found in this community', {
            extensions: { code: 'NOT_FOUND' },
          });
        }
      } else {
        throw new GraphQLError('Comment not found in this community', {
          extensions: { code: 'NOT_FOUND' },
        });
      }
    } else {
      throw new GraphQLError('Comment not found in this community', {
        extensions: { code: 'NOT_FOUND' },
      });
    }

    await logModerationAction(ctx, {
      communityId: args.communityId,
      moderatorId: dbUser.id,
      targetUserId: comment.userId,
      action: 'delete_comment',
      reason: args.reason,
      metadata: { commentId: args.commentId },
    });

    await ctx.prisma.comment.delete({ where: { id: args.commentId } });
    return true;
  },

  deleteCommunityThread: async (
    _parent: unknown,
    args: { communityId: string; threadId: string; reason?: string },
    ctx: Context,
  ) => {
    const dbUser = await getDbUser(ctx);

    const mod = await canModerate(ctx, args.communityId, dbUser.id);
    if (!mod && dbUser.role !== 'superuser') {
      throw new GraphQLError('You do not have permission to delete this thread', {
        extensions: { code: 'FORBIDDEN' },
      });
    }

    const thread = await ctx.prisma.forumThread.findUnique({
      where: { id: args.threadId },
      select: {
        authorId: true,
        category: { select: { communityId: true } },
      },
    });
    if (!thread) {
      throw new GraphQLError('Thread not found', { extensions: { code: 'NOT_FOUND' } });
    }
    if (thread.category.communityId !== args.communityId) {
      throw new GraphQLError('Thread not found in this community', {
        extensions: { code: 'NOT_FOUND' },
      });
    }

    await logModerationAction(ctx, {
      communityId: args.communityId,
      moderatorId: dbUser.id,
      targetUserId: thread.authorId,
      action: 'delete_post',
      reason: args.reason,
      metadata: { threadId: args.threadId },
    });

    await ctx.prisma.forumThread.delete({ where: { id: args.threadId } });
    return true;
  },

  deleteCommunityPost: async (
    _parent: unknown,
    args: { communityId: string; postId: string; reason?: string },
    ctx: Context,
  ) => {
    const dbUser = await getDbUser(ctx);

    const mod = await canModerate(ctx, args.communityId, dbUser.id);
    if (!mod && dbUser.role !== 'superuser') {
      throw new GraphQLError('You do not have permission to delete this post', {
        extensions: { code: 'FORBIDDEN' },
      });
    }

    const post = await ctx.prisma.forumPost.findUnique({
      where: { id: args.postId },
      select: {
        authorId: true,
        thread: { select: { category: { select: { communityId: true } } } },
      },
    });
    if (!post) {
      throw new GraphQLError('Post not found', { extensions: { code: 'NOT_FOUND' } });
    }
    if (post.thread.category.communityId !== args.communityId) {
      throw new GraphQLError('Post not found in this community', {
        extensions: { code: 'NOT_FOUND' },
      });
    }

    await logModerationAction(ctx, {
      communityId: args.communityId,
      moderatorId: dbUser.id,
      targetUserId: post.authorId,
      action: 'delete_post',
      reason: args.reason,
      metadata: { postId: args.postId },
    });

    await ctx.prisma.forumPost.update({
      where: { id: args.postId },
      data: { isDeleted: true, body: '[deleted]' },
    });
    return true;
  },
};

// ─── Field Resolvers ────────────────────────────────────────────────────────

export const communityFieldResolvers = {
  owner: (parent: CommunityParent, _args: unknown, ctx: Context) => {
    return ctx.prisma.user.findUnique({ where: { id: parent.ownerId } });
  },

  memberCount: (parent: CommunityParent, _args: unknown, ctx: Context) => {
    return ctx.loaders.communityMemberCount.load(parent.id);
  },

  myMembership: async (parent: CommunityParent, _args: unknown, ctx: Context) => {
    if (!ctx.user) return null;
    const dbUser = await ctx.prisma.user.findUnique({
      where: { cognitoSub: ctx.user.sub },
      select: { id: true },
    });
    if (!dbUser) return null;
    return ctx.prisma.communityMember.findUnique({
      where: { communityId_userId: { communityId: parent.id, userId: dbUser.id } },
    });
  },

  members: async (
    parent: CommunityParent,
    args: { first?: number; after?: string; page?: number },
    ctx: Context,
  ) => {
    const { skip, take } = buildPaginationArgs({
      first: args.first,
      after: args.after,
      page: args.page,
    });
    const where: Record<string, unknown> = {
      communityId: parent.id,
      status: 'active',
    };

    if (args.after) {
      where.joinedAt = { lt: decodeCursor(args.after) };
    }

    const [items, totalCount] = await Promise.all([
      ctx.prisma.communityMember.findMany({
        where,
        orderBy: { joinedAt: 'desc' },
        skip,
        take: take + 1,
      }),
      ctx.prisma.communityMember.count({ where }),
    ]);

    const hasNextPage = items.length > take;
    const edges = items.slice(0, take).map((m) => ({
      cursor: encodeCursor(m.joinedAt),
      node: m,
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

  // Photos in community albums
  photos: async (
    parent: CommunityParent,
    args: { first?: number; after?: string; page?: number },
    ctx: Context,
  ) => {
    const { skip, take } = buildPaginationArgs({
      first: args.first,
      after: args.after,
      page: args.page,
    });

    // Get all album IDs for this community
    const communityAlbumIds = await ctx.prisma.album.findMany({
      where: { communityId: parent.id },
      select: { id: true },
    });
    const albumIds = communityAlbumIds.map((a) => a.id);

    if (albumIds.length === 0) {
      return {
        edges: [],
        pageInfo: { hasNextPage: false, endCursor: null },
        totalCount: 0,
      };
    }

    // Get album photo entries for these albums, ordered by addedAt desc
    const where: Record<string, unknown> = {
      albumId: { in: albumIds },
    };
    if (args.after) {
      where.addedAt = { lt: decodeCursor(args.after) };
    }

    const [albumPhotos, totalCount] = await Promise.all([
      ctx.prisma.albumPhoto.findMany({
        where,
        orderBy: { addedAt: 'desc' },
        skip,
        take: take + 1,
        include: {
          photo: {
            include: { user: true, variants: true, tags: true },
          },
        },
      }),
      ctx.prisma.albumPhoto.count({ where }),
    ]);

    const hasNextPage = albumPhotos.length > take;
    const edges = albumPhotos.slice(0, take).map((ap) => ({
      cursor: encodeCursor(ap.addedAt),
      node: ap.photo,
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

  // Community albums
  albums: async (
    parent: CommunityParent,
    args: { first?: number; after?: string; page?: number },
    ctx: Context,
  ) => {
    const { skip, take } = buildPaginationArgs({
      first: args.first,
      after: args.after,
      page: args.page,
    });
    const where: Record<string, unknown> = { communityId: parent.id };

    if (args.after) {
      where.createdAt = { lt: decodeCursor(args.after) };
    }

    const [items, totalCount] = await Promise.all([
      ctx.prisma.album.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip,
        take: take + 1,
        include: {
          user: { include: { profile: true } },
          coverPhoto: { include: { variants: true } },
        },
      }),
      ctx.prisma.album.count({ where }),
    ]);

    const hasNextPage = items.length > take;
    const edges = items.slice(0, take).map((album) => ({
      cursor: encodeCursor(album.createdAt),
      node: album,
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

  // Hide invite code from non-admins
  inviteCode: async (parent: CommunityParent, _args: unknown, ctx: Context) => {
    if (!ctx.user) return null;
    const dbUser = await ctx.prisma.user.findUnique({
      where: { cognitoSub: ctx.user.sub },
      select: { id: true },
    });
    if (!dbUser) return null;
    const membership = await ctx.prisma.communityMember.findUnique({
      where: { communityId_userId: { communityId: parent.id, userId: dbUser.id } },
    });
    if (!membership || !['owner', 'admin'].includes(membership.role)) return null;
    // Fetch the actual invite code from DB since parent may not have it
    const community = await ctx.prisma.community.findUnique({
      where: { id: parent.id },
      select: { inviteCode: true },
    });
    return community?.inviteCode ?? null;
  },
};

export const communityMemberFieldResolvers = {
  user: (parent: CommunityMemberParent, _args: unknown, ctx: Context) => {
    return ctx.prisma.user.findUnique({ where: { id: parent.userId } });
  },

  community: (parent: CommunityMemberParent, _args: unknown, ctx: Context) => {
    return ctx.prisma.community.findUnique({ where: { id: parent.communityId } });
  },
};
