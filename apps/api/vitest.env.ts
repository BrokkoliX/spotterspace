/**
 * Vitest setup file — runs in the same process as each test file.
 *
 * Overrides DATABASE_URL so the PrismaClient singleton from @spotterspace/db
 * connects to the isolated test database instead of the dev database.
 *
 * This MUST run before any module imports PrismaClient, which is why
 * it's listed in `setupFiles` (not `globalSetup`).
 *
 * Configuration
 * -------------
 * Set `TEST_DATABASE_URL` in your environment (see .env.example). For local
 * development, the docker-compose in `docker/` exposes a ready-to-use test DB:
 *
 *   export TEST_DATABASE_URL=postgresql://spotterspace:spotterspace_dev@localhost:5433/spotterspace_test
 *
 * CI sets it via the workflow env block. There is intentionally NO fallback —
 * silent fallbacks caused production-vs-test DB confusion in the past.
 */

const testDatabaseUrl = process.env.TEST_DATABASE_URL;

if (!testDatabaseUrl) {
  throw new Error(
    'TEST_DATABASE_URL is not set. Export it before running vitest.\n' +
      'Example (matches docker-compose):\n' +
      '  export TEST_DATABASE_URL=postgresql://spotterspace:spotterspace_dev@localhost:5433/spotterspace_test\n' +
      'See .env.example for details.',
  );
}

process.env.DATABASE_URL = testDatabaseUrl;

// Pin dummy AWS credentials so the suite is hermetic. getUploadUrl and
// friends presign S3 URLs locally (no network call), but signing still needs
// *some* credentials. Without these, CI failed with "Could not load
// credentials from any providers", while locally the SDK silently fell back
// to the developer's real ~/.aws credentials. Env credentials take precedence
// over ~/.aws in the default provider chain, so tests can never sign with, or
// send, real keys.
process.env.AWS_ACCESS_KEY_ID = 'test';
process.env.AWS_SECRET_ACCESS_KEY = 'test';
process.env.AWS_REGION = process.env.AWS_REGION ?? 'us-east-1';
