# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Repository Structure

```
apps/
  web/        # Next.js 16 frontend (port 3000)
  api/        # Express + Apollo GraphQL API (port 4000)
packages/
  db/         # Prisma + PostgreSQL schema
  shared/     # Shared TypeScript types/constants
  eslint-config/
```

This is a Turborepo monorepo. All workspaces use npm.

## Commonly Used Commands

```bash
# Dev (runs all apps in parallel)
npm run dev

# Build all workspaces
npm run build

# Type check all
npm run typecheck

# Lint all
npm run lint

# Test all (pass TEST_DATABASE_URL for integration tests)
npm run test

# Test e2e (requires build first)
npm run test:e2e

# Format code
npm run format

# Database (packages/db)
npm run db:migrate    # Run Prisma migrations
npm run db:seed       # Seed database
npm run db:reset      # Reset database

# Individual app commands
cd apps/web && npm run dev
cd apps/api && npm run dev
cd packages/db && npm run db:migrate
```

## Architecture Overview

### API (`apps/api/src/`)

- **Apollo Server** on Express with GraphQL
- GraphQL schema defined in `schema.ts`, resolvers in `resolvers/`
- **JWT auth** via cookies + refresh tokens in DB
- **AWS Secrets Manager** for production secrets (skipped in dev when env vars present)
- **Stripe webhook** at `/api/stripe-webhook`
- Rate limiting: general, per-email password reset, auth-specific, seed endpoint
- Health check: `GET /health`
- Seed superuser: `POST /seed` (requires `x-jwt-secret` header)

**Auth flow**: JWT access token (1hr) + HttpOnly refresh cookie (7 days). Refresh token is rotated on use and stored in DB.

**Roles**: user → moderator → admin → superuser (superuser bypasses all role checks)

### Web Frontend (`apps/web/src/`)

- **Next.js 16** App Router with React 19
- **urql** for GraphQL client with custom auth exchange
- **Leaflet/React-Leaflet** for maps, **Mapbox GL** also available
- Image upload: presigned S3 URLs via `getUploadUrl` mutation
- Route structure: app router pages under `app/` (auth, settings, photos, communities, admin, etc.)

### Database (`packages/db/prisma/`)

- **PostgreSQL 16 + PostGIS** with `pg_trgm` extension
- Prisma schema defines all entities (User, Photo, Aircraft, Community, Forum, Marketplace, etc.)
- Soft-delete pattern: entities have `isDeleted` boolean; `deletedFilter()` helper shows/hides based on role
- Aircraft hierarchy: Manufacturer → Family → Variant → Aircraft
- Photo location privacy: exact / approximate (~0.5km jitter) / hidden

### Shared Types (`packages/shared/`)

- Re-exports Prisma client types
- Contains enums: UserRole, PhotoLicense, ModerationStatus, etc.

## Key Patterns

**DataLoader batching**: N+1 queries are batched via DataLoader (`loaders.ts`) for userFollowerCount, userPhotoCount, photoLikeCount, etc.

**CSRF protection**: `csrfGuard` middleware validates Origin header on mutations. Browsers omit Origin on same-site requests.

**Notification system**: `createNotification()` helper is fire-and-forget (no await) across like/follow/comment mutations.

**Image variants**: After S3 upload, `generateVariants()` creates: thumbnail (160px), thumbnail_16x9 (640px wide), display (1920px), full_res, watermarked.

## Pagination

The API uses **offset-based pagination** via `buildPaginationArgs()` (`apps/api/src/utils/resolverHelpers.ts`). All paginated queries accept both cursor-based (`first`/`after`) and offset-based (`first`/`page`) arguments.

**Resolver pattern** — when adding `page: Int` to schema, the resolver MUST call `buildPaginationArgs`:

```typescript
const { skip, take, cursorWhere } = buildPaginationArgs({
  first: args.first,
  after: args.after,
  page: args.page,
});
const [items, totalCount] = await ctx.prisma.model.findMany({
  where: { ...where, ...cursorWhere },
  orderBy: { createdAt: 'desc' },
  skip,
  take: take + 1, // +1 to detect hasNextPage
});
```

**GraphQL query must include `$page: Int`** — the web frontend passes `page` as a variable. If `$page: Int` is missing from the query definition in `lib/queries.ts`, page-based pagination silently falls back to page 1.

**URL sync** — all pages with pagination sync the page number to URL query params:

```typescript
// Wrap with Suspense when using useSearchParams in client components
function Page() {
  return <Suspense fallback={...}><PageInner /></Suspense>;
}
function PageInner() {
  const searchParams = useSearchParams();
  const router = useRouter();
  const initialPage = parseInt(searchParams.get('page') ?? '1', 10);
  const [currentPage, setCurrentPage] = useState(initialPage);

  const handlePageChange = (page: number) => {
    setCurrentPage(page);
    const params = new URLSearchParams(searchParams.toString());
    params.set('page', String(page));
    router.push(`/?${params.toString()}`, { scroll: false });
  };
}
```

## Environment Variables

See `.env.example` at root. Key variables:

- `DATABASE_URL` — PostgreSQL connection string
- `JWT_SECRET` — Token signing secret (fails startup in production if dev fallback)
- `API_PORT` / `WEB_PORT` — Port overrides
- `WEB_BASE_URL` — Frontend URL for CORS (required in production; injected by CDK)
- `S3_BUCKET` — S3 bucket name (production: `spotterhub-photos`; injected by CDK)
- `FROM_EMAIL` — Sender address for transactional email (injected by CDK)
- `RESEND_API_KEY`, `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET` — Third-party services

## Infrastructure (CDK)

The CDK stack is in `infrastructure/`. Deploy with explicit image tags derived from git SHAs:

```bash
cd infrastructure
DOMAIN_NAME=spotterspace.com HOSTED_ZONE_ID=Z00113712EMKXVCPQFWZW STAGE=dev \
  API_IMAGE_TAG=<git-sha> WEB_IMAGE_TAG=<git-sha> \
  npx cdk deploy --require-approval never
```

Dev task sizing (as of 2026-05-25, after the api downsize): api 256 CPU / 512 MB, web 256 CPU / 512 MB. The CDK uses separate constants (`apiTaskCpu`, `apiTaskMemory`, `webTaskCpu`, `webTaskMemory`) so they can be tuned independently.
