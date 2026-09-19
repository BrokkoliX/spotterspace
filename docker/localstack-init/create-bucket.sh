#!/bin/bash
# Auto-create the S3 buckets on LocalStack startup.
# This runs as a "ready" hook — after LocalStack services are available.
#
# LocalStack community edition does not persist state (PERSISTENCE is a Pro
# feature), so buckets and objects are wiped on every container restart and
# this hook is what brings the buckets back. Objects are not restored —
# regenerate the seed photos with packages/db/prisma/seed-images.ts.
#
# spotterhub-photos is the bucket the app actually uses: the seed photo URLs
# and the dev `images.remotePatterns` in apps/web/next.config.ts both point at
# it. spotterspace-photos is kept for anything still configured with the
# .env.example default.

for bucket in spotterhub-photos spotterspace-photos; do
  echo "🪣 Creating ${bucket} bucket..."
  awslocal s3 mb "s3://${bucket}" --region us-east-1 2>/dev/null || true
done
echo "✅ Buckets ready."
