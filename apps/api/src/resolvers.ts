import { GraphQLScalarType, Kind } from 'graphql';

import { adminMutationResolvers, adminQueryResolvers } from './resolvers/adminResolvers.js';
import {
  aircraftHierarchyFieldResolvers,
  aircraftHierarchyMutationResolvers,
  aircraftHierarchyQueryResolvers,
} from './resolvers/aircraftHierarchyResolvers.js';
import {
  aircraftFieldResolvers,
  aircraftMutationResolvers,
  aircraftQueryResolvers,
} from './resolvers/aircraftResolvers.js';
import {
  airlineFieldResolvers,
  airlineMutationResolvers,
  airlineQueryResolvers,
} from './resolvers/airlineResolvers.js';
import {
  airportFieldResolvers,
  airportMutationResolvers,
  airportQueryResolvers,
} from './resolvers/airportResolvers.js';
import {
  albumFieldResolvers,
  albumMutationResolvers,
  albumQueryResolvers,
} from './resolvers/albumResolvers.js';
import { authMutationResolvers } from './resolvers/authResolvers.js';
import {
  badgeFieldResolvers,
  badgeMutationResolvers,
  badgeQueryResolvers,
} from './resolvers/badgeResolvers.js';
import {
  categoryFieldResolvers,
  categoryMutationResolvers,
  categoryQueryResolvers,
} from './resolvers/categoryResolvers.js';
import {
  commentFieldResolvers,
  commentMutationResolvers,
  commentQueryResolvers,
} from './resolvers/commentResolvers.js';
import {
  communityModerationLogFieldResolvers,
  communityModerationMutationResolvers,
  communityModerationQueryResolvers,
} from './resolvers/communityModerationResolvers.js';
import {
  communityFieldResolvers,
  communityMemberFieldResolvers,
  communityMutationResolvers,
  communityQueryResolvers,
} from './resolvers/communityResolvers.js';
import {
  contactMessageQueryResolvers,
  contactMessageMutationResolvers,
  contactMessageFieldResolvers,
} from './resolvers/contactMessageResolvers.js';
import {
  communityEventFieldResolvers,
  eventAttendeeFieldResolvers,
  eventMutationResolvers,
  eventQueryResolvers,
} from './resolvers/eventResolvers.js';
import {
  airportFollowFieldResolvers,
  followFieldResolvers,
  followMutationResolvers,
  followQueryResolvers,
} from './resolvers/followResolvers.js';
import {
  forumCategoryFieldResolvers,
  forumMutationResolvers,
  forumPostFieldResolvers,
  forumQueryResolvers,
  forumThreadFieldResolvers,
} from './resolvers/forumResolvers.js';
import { likeFieldResolvers, likeMutationResolvers } from './resolvers/likeResolvers.js';
import { locationQueryResolvers } from './resolvers/locationResolvers.js';
import {
  marketplaceCollectiblesQueryResolvers,
  marketplaceCollectiblesMutationResolvers,
  marketplaceItemFieldResolvers,
  marketplaceItemImageFieldResolvers,
  sellerFeedbackFieldResolvers,
  marketplaceCategoryFieldResolvers,
  sellerProfileCollectiblesFieldResolvers,
} from './resolvers/marketplaceCollectiblesResolvers.js';
import {
  marketplaceQueryResolvers,
  marketplaceMutationResolvers,
  photoListingFieldResolvers,
  orderFieldResolvers,
  sellerProfileFieldResolvers,
} from './resolvers/marketplaceResolvers.js';
import {
  notificationFieldResolvers,
  notificationMutationResolvers,
  notificationQueryResolvers,
} from './resolvers/notificationResolvers.js';
import {
  pendingListItemFieldResolvers,
  pendingListItemMutationResolvers,
  pendingListItemQueryResolvers,
} from './resolvers/pendingListItemResolvers.js';
import {
  photoFieldResolvers,
  photoMutationResolvers,
  photoQueryResolvers,
} from './resolvers/photoResolvers.js';
import { profileMutationResolvers } from './resolvers/profileResolvers.js';
import { reportMutationResolvers } from './resolvers/reportResolvers.js';
import { searchQueryResolvers } from './resolvers/searchResolvers.js';
import {
  siteSettingsMutationResolvers,
  siteSettingsQueryResolvers,
} from './resolvers/siteSettingsResolvers.js';
import { spottingLocationMutationResolvers } from './resolvers/spottingLocationResolvers.js';
import { tierMutationResolvers, tierQueryResolvers } from './resolvers/tierResolvers.js';
import {
  userFieldResolvers,
  userMutationResolvers,
  userQueryResolvers,
} from './resolvers/userResolvers.js';

// ─── JSON Scalar ────────────────────────────────────────────────────────────

function parseLiteralAst(ast: import('graphql').ValueNode): unknown {
  switch (ast.kind) {
    case Kind.STRING:
      try {
        return JSON.parse(ast.value);
      } catch {
        return ast.value;
      }
    case Kind.INT:
      return parseInt(ast.value, 10);
    case Kind.FLOAT:
      return parseFloat(ast.value);
    case Kind.BOOLEAN:
      return ast.value;
    case Kind.NULL:
      return null;
    case Kind.LIST:
      return ast.values.map(parseLiteralAst);
    case Kind.OBJECT:
      return Object.fromEntries(
        ast.fields.map((field) => [field.name.value, parseLiteralAst(field.value)]),
      );
    default:
      return null;
  }
}

const JSONScalar = new GraphQLScalarType({
  name: 'JSON',
  description: 'Arbitrary JSON value',
  serialize: (value) => value,
  parseValue: (value) => value,
  parseLiteral: parseLiteralAst,
});

const DecimalScalar = new GraphQLScalarType({
  name: 'Decimal',
  description: 'Arbitrary decimal value (serialized as string)',
  serialize: (value: unknown) => {
    if (typeof value === 'string') return value;
    if (typeof value === 'number') return String(value);
    return String(value);
  },
  parseValue: (value: unknown) => {
    if (typeof value === 'string') return value;
    if (typeof value === 'number') return String(value);
    throw new Error(`Decimal cannot represent value: ${value}`);
  },
  parseLiteral(ast: unknown) {
    if ((ast as { kind: string }).kind === Kind.STRING) {
      return (ast as { value: string }).value;
    }
    if ((ast as { kind: string }).kind === Kind.FLOAT) {
      return String((ast as { value: number }).value);
    }
    if ((ast as { kind: string }).kind === Kind.INT) {
      return String((ast as { value: string }).value);
    }
    throw new Error('Decimal cannot represent literal');
  },
});

// ─── Resolver Map ───────────────────────────────────────────────────────────

export const resolvers = {
  JSON: JSONScalar,
  Decimal: DecimalScalar,

  Query: {
    ...userQueryResolvers,
    ...photoQueryResolvers,
    ...commentQueryResolvers,
    ...searchQueryResolvers,
    ...airportQueryResolvers,
    ...albumQueryResolvers,
    ...followQueryResolvers,
    ...locationQueryResolvers,
    ...adminQueryResolvers,
    ...communityQueryResolvers,
    ...communityModerationQueryResolvers,
    ...forumQueryResolvers,
    ...eventQueryResolvers,
    ...notificationQueryResolvers,
    ...siteSettingsQueryResolvers,
    ...tierQueryResolvers,
    ...aircraftQueryResolvers,
    ...aircraftHierarchyQueryResolvers,
    ...airlineQueryResolvers,
    ...categoryQueryResolvers,
    ...pendingListItemQueryResolvers,
    ...marketplaceQueryResolvers,
    ...marketplaceCollectiblesQueryResolvers,
    ...contactMessageQueryResolvers,
    ...badgeQueryResolvers,
  },

  Mutation: {
    ...authMutationResolvers,
    ...profileMutationResolvers,
    ...userMutationResolvers,
    ...photoMutationResolvers,
    ...likeMutationResolvers,
    ...followMutationResolvers,
    ...commentMutationResolvers,
    ...albumMutationResolvers,
    ...reportMutationResolvers,
    ...spottingLocationMutationResolvers,
    ...adminMutationResolvers,
    ...communityMutationResolvers,
    ...communityModerationMutationResolvers,
    ...forumMutationResolvers,
    ...eventMutationResolvers,
    ...notificationMutationResolvers,
    ...siteSettingsMutationResolvers,
    ...tierMutationResolvers,
    ...aircraftMutationResolvers,
    ...airportMutationResolvers,
    ...aircraftHierarchyMutationResolvers,
    ...airlineMutationResolvers,
    ...categoryMutationResolvers,
    ...pendingListItemMutationResolvers,
    ...marketplaceMutationResolvers,
    ...marketplaceCollectiblesMutationResolvers,
    ...contactMessageMutationResolvers,
    ...badgeMutationResolvers,
  },

  User: {
    ...userFieldResolvers,
    ...followFieldResolvers,
  },

  Photo: {
    ...photoFieldResolvers,
    ...likeFieldResolvers,
  },

  Comment: commentFieldResolvers,

  Airport: {
    ...airportFieldResolvers,
    ...airportFollowFieldResolvers,
  },

  Album: albumFieldResolvers,

  Community: communityFieldResolvers,

  CommunityMember: communityMemberFieldResolvers,

  CommunityModerationLog: communityModerationLogFieldResolvers,

  ForumCategory: forumCategoryFieldResolvers,

  ForumThread: forumThreadFieldResolvers,

  ForumPost: forumPostFieldResolvers,

  CommunityEvent: communityEventFieldResolvers,

  EventAttendee: eventAttendeeFieldResolvers,

  Notification: notificationFieldResolvers,

  Aircraft: {
    ...aircraftFieldResolvers,
  },

  AircraftManufacturer: aircraftHierarchyFieldResolvers.AircraftManufacturer,

  AircraftFamily: aircraftHierarchyFieldResolvers.AircraftFamily,

  AircraftVariant: aircraftHierarchyFieldResolvers.AircraftVariant,

  Airline: airlineFieldResolvers.Airline,

  PhotoCategory: categoryFieldResolvers.PhotoCategory,

  AircraftSpecificCategory: categoryFieldResolvers.AircraftSpecificCategory,

  PendingListItem: pendingListItemFieldResolvers.PendingListItem,

  PhotoListing: photoListingFieldResolvers,

  Order: orderFieldResolvers,

  SellerProfile: {
    ...sellerProfileFieldResolvers,
    ...sellerProfileCollectiblesFieldResolvers,
  },

  MarketplaceItem: marketplaceItemFieldResolvers,

  MarketplaceItemImage: marketplaceItemImageFieldResolvers,

  SellerFeedback: sellerFeedbackFieldResolvers,

  MarketplaceCategory: marketplaceCategoryFieldResolvers,

  ContactMessage: contactMessageFieldResolvers.ContactMessage,

  UserBadge: badgeFieldResolvers.UserBadge,
};
