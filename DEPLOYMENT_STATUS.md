# SpotterHub — Deployment & Operations Guide

> **Last updated:** 2026-05-25
> **Domain:** spotterspace.com (registered 2026-04-11 via Amazon Registrar)
> **AWS Region:** us-east-1
> **AWS Account:** 654654553862

---

## Table of Contents

1. [Architecture Overview](#architecture-overview)
2. [How to Deploy](#how-to-deploy)
3. [CI/CD Pipeline](#cicd-pipeline)
4. [Task Definition Management](#task-definition-management)
5. [Database Access](#database-access)
6. [Superuser & Auth](#superuser--auth)
7. [Secrets Manager](#secrets-manager)
8. [Docker Builds](#docker-builds)
9. [DNS & HTTPS](#dns--https)
10. [Network & Security Groups](#network--security-groups)
11. [Monitoring & Health Checks](#monitoring--health-checks)
12. [Troubleshooting](#troubleshooting)
13. [File Reference](#file-reference)

---

## Architecture Overview

```
        ┌──────────────────────────────────────┐
        │   www.spotterspace.com (CNAME → ALB) │
        │   api.spotterspace.com (CNAME → ALB) │
        │   spotterspace.com  (A alias → ALB,  │
        │   301 → www; HTTP 301 → HTTPS)       │
        └──────────────────────────────────────┘
                       │
                       ▼
┌──────────────────────────────────────┐
│         ALB (spotterspace-alb)       │
│  :443 HTTPS  ─── host-based rules    │
│  :80  HTTP   ─── host-based rules    │
│  api.* → apiTG   │  www.* → webTG    │
└──────┬───────────────────┬───────────┘
       │                   │
       ▼                   ▼
┌──────────────┐   ┌──────────────┐
│ ECS Fargate  │   │ ECS Fargate  │
│ API (Apollo) │   │ Web (Next.js)│
│ Port 4000    │   │ Port 3000    │
│ Private Subs │   │ Private Subs │
└──────┬───────┘   └──────────────┘
       │ (private subnets + NAT)
       ▼
┌──────────────┐     ┌──────────────┐
│ RDS Postgres │     │ S3 Bucket    │
│ spotterhub-db│     │ spotterhub-  │
│ Port 5432    │     │ photos       │
└──────────────┘     └──────────────┘

Photo CDN: d2ur47prd8ljwz.cloudfront.net → s3://spotterhub-photos
(internal CloudFront; no DNS alias, used by signed URLs from the API)
```

### Live Endpoints

| Endpoint    | URL                                  | Status |
| ----------- | ------------------------------------ | ------ |
| Web App     | https://www.spotterspace.com         | ✅     |
| API GraphQL | https://api.spotterspace.com/graphql | ✅     |
| API Health  | https://api.spotterspace.com/health  | ✅     |

> **Apex and HTTP (2026-09-19):** `spotterspace.com` is a Route 53 alias A record to the ALB, and a `:443` listener rule (priority 50) 301-redirects it to `https://www.spotterspace.com`. Every `:80` request — default action and the `api.*`/`www.*` host rules — 301-redirects to the same host/path over HTTPS; previously plain HTTP was served unencrypted. CloudFront is still not deployed (`enableCloudFront` is false). Applied with `scripts/alb-https-apex.sh` (`plan` / `apply` / `verify` / `rollback`) because `cdk deploy` is blocked by drift — see [CDK Drift Warning](#cdk-drift-warning).

### Key AWS Resources

| Resource            | Name / ID                                                           |
| ------------------- | ------------------------------------------------------------------- |
| ECS Cluster         | `spotterspace-cluster`                                              |
| API ECS Service     | `spotterspace-dev-api`                                              |
| Web ECS Service     | `spotterspace-dev-web`                                              |
| API ECR Repo        | `654654553862.dkr.ecr.us-east-1.amazonaws.com/spotterspace-dev-api` |
| Web ECR Repo        | `654654553862.dkr.ecr.us-east-1.amazonaws.com/spotterspace-dev-web` |
| API Task Definition | `spotterspace-dev-api` (current: :254, 256 CPU / 512 MB)            |
| Web Task Definition | `spotterspace-dev-web` (current: :199, 256 CPU / 512 MB)            |
| RDS                 | `spotterhub-db` (PostgreSQL 16.3, db.t3.micro, private subnets)     |
| S3                  | `spotterhub-photos`                                                 |
| ALB                 | `spotterspace-alb`                                                  |
| Secrets Manager     | `spotterhub/DATABASE_URL`, `spotterhub/JWT_SECRET`                  |
| Route 53 Zone       | `Z00113712EMKXVCPQFWZW`                                             |
| VPC                 | `vpc-09a6870488b73260e` (10.0.0.0/20)                               |

---

## How to Deploy

### Standard Flow (push to main)

Pushing to `main` triggers GitHub Actions, which runs CI checks (lint → typecheck → test → build), builds Docker images for API and Web, pushes to ECR with both `:latest` and `:{sha}` tags, and triggers ECS redeployment for both services (~5-7 min total).

Verify after rollout:

```bash
# Check API health
curl -s https://api.spotterspace.com/health

# Check ECS deployment status
aws ecs describe-services --cluster spotterspace-cluster \
  --services spotterspace-dev-api spotterspace-dev-web \
  --region us-east-1 --no-cli-pager \
  --query 'services[*].{Name:serviceName,Running:runningCount,Desired:desiredCount,Status:deployments[0].rolloutState}'
```

### CDK Deploy (infrastructure changes)

Use this when deploying CDK infrastructure changes or when you need to pick up a specific image tag. Always pass an explicit git SHA for `API_IMAGE_TAG` and `WEB_IMAGE_TAG`.

```bash
cd infrastructure
DOMAIN_NAME=spotterspace.com HOSTED_ZONE_ID=Z00113712EMKXVCPQFWZW STAGE=dev \
  API_IMAGE_TAG=<git-sha> WEB_IMAGE_TAG=<git-sha> \
  npx cdk deploy --require-approval never
```

### Manual Deploy (workflow_dispatch)

Go to **GitHub Actions → Deploy to AWS → Run workflow** and choose `dev` or `prod`.

### Deploy Only API or Only Web

```bash
# API only
aws ecs update-service --cluster spotterspace-cluster \
  --service spotterspace-dev-api --force-new-deployment \
  --region us-east-1 --no-cli-pager

# Web only
aws ecs update-service --cluster spotterspace-cluster \
  --service spotterspace-dev-web --force-new-deployment \
  --region us-east-1 --no-cli-pager
```

### Verify Deployment

```bash
curl -s -o /dev/null -w "%{http_code}" https://www.spotterspace.com
```

---

## CI/CD Pipeline

### Workflow: `.github/workflows/ci.yml`

**Trigger:** Pull requests and pushes to `main`.

```
Lint → Typecheck → Test → Build
```

Runs on every PR and every push to `main`. The build step generates the URQL client types via codegen.

### Workflow: `.github/workflows/deploy.yml`

**Trigger:** Push to `main` (paths: `apps/api/**`, `apps/web/**`, `packages/**`, `.github/workflows/deploy.yml`) or manual `workflow_dispatch`.

**Two sequential jobs:**

1. **deploy-api:** Checkout → AWS auth → ECR login → Docker build & push (`spotterspace-dev-api:latest`) → Force ECS redeployment
2. **deploy-web:** (needs `deploy-api`) Checkout → AWS auth → ECR login → Docker build & push (`spotterspace-dev-web:latest`) → Force ECS redeployment

Web job waits for API to complete before building, but the two ECS redeployments run in parallel once both images are pushed.

**Migrations:** These run automatically inside the API container via `docker-entrypoint.sh` before the server starts. The entrypoint runs `prisma migrate deploy` on every startup (idempotent, safe to re-run).

### GitHub Secrets & Variables

**Secrets:**

| Secret                     | Description                         |
| -------------------------- | ----------------------------------- |
| `AWS_ACCESS_KEY_ID`        | IAM user access key for deployments |
| `AWS_SECRET_ACCESS_KEY`    | IAM user secret key                 |
| `NEXT_PUBLIC_MAPBOX_TOKEN` | Mapbox GL JS token for map features |

**Variables:**

| Variable         | Value              | Description        |
| ---------------- | ------------------ | ------------------ |
| `AWS_ACCOUNT_ID` | `654654553862`     | AWS account number |
| `DOMAIN_NAME`    | `spotterspace.com` | Root domain        |

---

## Task Definition Management

ECS task definitions may pin Docker images to specific tags (e.g., `:sha-xxx`). If `force-new-deployment` doesn't pick up the latest image, register a new task definition revision pointing to `:latest`.

### Check Current Image Tag

```bash
aws ecs describe-task-definition --task-definition spotterspace-dev-api \
  --query 'taskDefinition.containerDefinitions[0].image' \
  --output text --no-cli-pager
```

If it shows `:latest`, a simple `force-new-deployment` will pull the newest image. If it shows a specific tag, follow the steps below.

### Update API Task Definition

```bash
# 1. Export current task definition
aws ecs describe-task-definition \
  --task-definition spotterspace-dev-api \
  --query 'taskDefinition' --no-cli-pager > /tmp/td.json

# 2. Create clean version with :latest tag (requires jq)
jq '{family,containerDefinitions,taskRoleArn,executionRoleArn,networkMode,requiresCompatibilities,cpu,memory}' \
  /tmp/td.json | sed 's|spotterspace-dev-api:[^"]*|spotterspace-dev-api:latest|g' > /tmp/clean-td.json

# 3. Register new revision
aws ecs register-task-definition \
  --cli-input-json file:///tmp/clean-td.json \
  --region us-east-1 --query 'taskDefinition.taskDefinitionArn' \
  --output text --no-cli-pager
# → outputs: arn:aws:ecs:...:task-definition/spotterspace-dev-api:NEW_REV

# 4. Update service with new revision
aws ecs update-service --cluster spotterspace-cluster \
  --service spotterspace-dev-api \
  --task-definition spotterspace-dev-api:NEW_REV \
  --force-new-deployment --region us-east-1 --no-cli-pager
```

### Update Web Task Definition

Same process, but **omit `taskRoleArn`** (the web task has no task role):

```bash
# 1. Export
aws ecs describe-task-definition \
  --task-definition spotterspace-dev-web \
  --query 'taskDefinition' --no-cli-pager > /tmp/web-td.json

# 2. Clean — note: no taskRoleArn
jq '{family,containerDefinitions,executionRoleArn,networkMode,requiresCompatibilities,cpu,memory}' \
  /tmp/web-td.json | sed 's|spotterspace-dev-web:[^"]*|spotterspace-dev-web:latest|g' > /tmp/clean-web-td.json

# 3. Register
aws ecs register-task-definition \
  --cli-input-json file:///tmp/clean-web-td.json \
  --region us-east-1 --query 'taskDefinition.taskDefinitionArn' \
  --output text --no-cli-pager

# 4. Deploy
aws ecs update-service --cluster spotterspace-cluster \
  --service spotterspace-dev-web \
  --task-definition spotterspace-dev-web:NEW_REV \
  --force-new-deployment --region us-east-1 --no-cli-pager
```

---

## Database Access

- RDS is in **private subnets** — it is **NOT accessible** from CloudShell, the internet, or your local machine
- Only ECS tasks (running in the same VPC private subnets) can reach it
- The API container runs **Prisma migrations automatically on startup** via `docker-entrypoint.sh` — it simply runs `prisma migrate deploy` and starts the server (idempotent, no recovery or cleanup logic)
- To run ad-hoc SQL, enable **ECS Exec** on the API service and run commands inside the container

### Emergency Schema Repair (via ECS run-task)

If the database schema drifts from the Prisma schema (e.g., missing tables while `_prisma_migrations` still has records), you cannot fix this with `prisma migrate deploy` alone. Use this technique to run one-off Prisma commands inside the VPC.

> **Important — read the verification step at the bottom before walking away.** In May 2026 thirteen one-off tasks accumulated as zombies because their inner commands hung silently and nothing supervised them. Total cost: ~$510/month until cleanup. The procedure below is now hardened with `timeout` and a mandatory verification step to prevent recurrence. The `spotterspace-dev-orphan-fargate-tasks` CloudWatch alarm fires if running task count exceeds 3 for an hour as a backstop.

```bash
# 1. Export current API task definition and create a one-off version with entrypoint override.
#    The `timeout 600` wrapper kills the inner command after 10 minutes if it hangs;
#    the explicit `exit` after `&&` forces the container to terminate on success.
aws ecs describe-task-definition --task-definition spotterspace-dev-api \
  --query 'taskDefinition' --no-cli-pager > /tmp/td.json

jq '{family: "spotterspace-db-repair", containerDefinitions: (.containerDefinitions | map(. + {
  entryPoint: ["/bin/sh", "-c"],
  command: ["timeout 600 npx prisma db push --schema packages/db/prisma/schema.prisma --accept-data-loss && echo DONE; exit"],
  essential: true
})), taskRoleArn, executionRoleArn, networkMode, requiresCompatibilities, cpu, memory}' \
  /tmp/td.json > /tmp/repair-td.json

# 2. Register the one-off task definition
aws ecs register-task-definition --cli-input-json file:///tmp/repair-td.json \
  --region us-east-1 --no-cli-pager

# 3. Run it in the VPC (use the same subnets and security groups as the API service)
aws ecs run-task --cluster spotterspace-cluster \
  --task-definition spotterspace-db-repair \
  --launch-type FARGATE \
  --network-configuration '{
    "awsvpcConfiguration": {
      "subnets": ["subnet-082c94f0897298f6e","subnet-096b774ed307c85ed"],
      "securityGroups": ["sg-08e5864c53710a095"],
      "assignPublicIp": "DISABLED"
    }
  }' --region us-east-1 --no-cli-pager

# 4. After tables are recreated, re-baseline migration history:
#    Register another one-off task with command:
#    "timeout 600 npx prisma migrate resolve --applied <migration_name> --schema packages/db/prisma/schema.prisma; exit"
#    Repeat for each migration.

# 5. Clean up: deregister the one-off task definitions
aws ecs deregister-task-definition --task-definition spotterspace-db-repair:1 \
  --region us-east-1 --no-cli-pager
```

#### Mandatory verification step (before walking away)

Every running task must belong to a managed service. Anything in `family:*` is a leftover one-off and must be stopped. Run this after step 5 and before closing the terminal:

```bash
aws ecs list-tasks --cluster spotterspace-cluster --region us-east-1 \
  --query 'taskArns[]' --output text | xargs -n1 \
aws ecs describe-tasks --cluster spotterspace-cluster --region us-east-1 \
  --query 'tasks[].{Group:group,StartedBy:startedBy,Task:taskArn}' \
  --output table --tasks
```

Every row must have `Group` starting with `service:` (e.g. `service:spotterspace-dev-api`). If any row shows `family:<name>`, stop it immediately:

```bash
aws ecs stop-task --cluster spotterspace-cluster --region us-east-1 \
  --task <taskArn-from-table-above> \
  --reason 'Cleanup of one-off run-task'
```

#### Convention for new one-off task commands

When writing any future `aws ecs run-task` invocation, follow this pattern for the container command override so it self-terminates on hang:

```bash
command: ["sh", "-c", "timeout <max-seconds> <real-command>; exit"]
```

This will use `timeout 600 npx prisma migrate deploy; exit` for the example above, where `600` is a hard ceiling beyond which the inner command is killed regardless of progress. The trailing `; exit` ensures the container exits even if the inner command is killed by `timeout` (which exits non-zero — without `exit`, some shells would keep the container alive on certain inner-command crashes).

### Connection String

Stored in Secrets Manager as `spotterhub/DATABASE_URL`:

```bash
aws secretsmanager get-secret-value \
  --secret-id spotterhub/DATABASE_URL \
  --query SecretString --output text
```

Output format: `{"DATABASE_URL":"postgresql://user:pass@spotterhub-db.xxx.us-east-1.rds.amazonaws.com:5432/spotterhub"}`

---

## Superuser & Auth

### Dev Auth Mode

The API uses a dev-mode authentication system (not AWS Cognito):

- **signUp** mutation creates a user with a SHA-256 hashed password stored as `cognitoSub` (prefix `dev1-`)
- **signIn** mutation verifies the password by recomputing the hash

### Production Superuser

| Field    | Value               |
| -------- | ------------------- |
| Email    | `robi_sz@yahoo.com` |
| Password | `Jerusalem!25`      |
| Role     | `superuser`         |

### One-Time Seed Endpoint

The API exposes a `POST /seed` endpoint that upserts the superuser. It requires the JWT_SECRET as an auth header and a JSON body with `email`, `username`, and `password`:

```bash
# 1. Get the JWT_SECRET value
JWT_SECRET=$(aws secretsmanager get-secret-value \
  --secret-id spotterhub/JWT_SECRET \
  --query SecretString --output text \
  | python3 -c "import sys,json; print(json.load(sys.stdin)['JWT_SECRET'])")

# 2. Call /seed
curl -X POST https://api.spotterspace.com/seed \
  -H "x-jwt-secret: $JWT_SECRET" \
  -H "Content-Type: application/json" \
  -d '{"email":"robi_sz@yahoo.com","username":"robi_sz","password":"Jerusalem!25"}'
```

The upsert sets `emailVerified: true` on both create and update, so re-running `/seed` will also fix a superuser whose email was not previously verified.

### Admin: Verify Email

The API exposes a `POST /admin/verify-email` endpoint to manually mark any user's email as verified. Protected by JWT_SECRET:

```bash
JWT_SECRET=$(aws secretsmanager get-secret-value \
  --secret-id spotterhub/JWT_SECRET \
  --query SecretString --output text \
  | python3 -c "import sys,json; print(json.load(sys.stdin)['JWT_SECRET'])")

curl -X POST https://api.spotterspace.com/admin/verify-email \
  -H "x-jwt-secret: $JWT_SECRET" \
  -H "Content-Type: application/json" \
  -d '{"email":"user@example.com"}'
```

---

## Secrets Manager

| Secret ID                 | Contents                              |
| ------------------------- | ------------------------------------- |
| `spotterhub/DATABASE_URL` | `{"DATABASE_URL":"postgresql://..."}` |
| `spotterhub/JWT_SECRET`   | `{"JWT_SECRET":"..."}`                |

**Important:** The prefix is `spotterhub/`, NOT `spotterspace/`.

The API loads these at startup via `@aws-sdk/client-secrets-manager`. They are fetched directly by the app code using the ECS task role — not injected via ECS task definition secrets.

### Retrieve Secrets (from CloudShell)

```bash
aws secretsmanager get-secret-value --secret-id spotterhub/DATABASE_URL --query SecretString --output text
aws secretsmanager get-secret-value --secret-id spotterhub/JWT_SECRET --query SecretString --output text
```

---

## Docker Builds

### API (`apps/api/Dockerfile`)

- **Multi-stage:** Node 20 Alpine (build) → Node 20 Alpine (runtime)
- **Build:** Copies monorepo → `npm install --workspaces --ignore-scripts` → `prisma generate` → `turbo build --filter=@spotterspace/api` → `npm prune --production`
- **Runtime:** Non-root user (`nodeapp:1001`)
- **Entrypoint:** `docker-entrypoint.sh` → runs `prisma migrate deploy` (idempotent, no recovery logic) → `node dist/index.js`
- **Port:** 4000
- **Health check:** `wget -qO- http://localhost:4000/health` (start-period 60s accounts for migration time on cold starts)
- **Startup sequence:** Run `prisma migrate deploy` → Start Apollo Server

### Web (`apps/web/Dockerfile`)

- **Multi-stage:** Node 20 Alpine (build) → Node 20 (runtime)
- **Build args:** `NEXT_PUBLIC_API_URL`, `NEXT_PUBLIC_MAPBOX_TOKEN` (baked into bundle at build time)
- **Port:** 3000
- **Entrypoint:** `node apps/web/apps/web/server.js` (standalone output)
- **Critical path:** Next.js standalone output nests at `apps/web/apps/web/server.js` in monorepos:

```dockerfile
COPY --from=builder /app/apps/web/.next/standalone /app/apps/web
COPY --from=builder /app/apps/web/.next/static /app/apps/web/apps/web/.next/static
CMD ["node", "apps/web/apps/web/server.js"]
```

### Key Configuration

- Next.js rewrites `/api/graphql` → `NEXT_PUBLIC_API_URL` (proxy to API server, avoids CORS)
- The rewrite is defined in `apps/web/next.config.ts`

---

## DNS & HTTPS

| Record                 | Type  | Target       |
| ---------------------- | ----- | ------------ |
| `www.spotterspace.com` | CNAME | ALB DNS name |
| `api.spotterspace.com` | CNAME | ALB DNS name |

| `spotterspace.com` | A (alias) | ALB — redirected to `www.` by a `:443` listener rule |

The apex record and its redirect rule were added on 2026-09-19 by `scripts/alb-https-apex.sh`; see the Architecture Overview note above.

**SSL:** ACM certificate covers `spotterspace.com` + `*.spotterspace.com`, DNS-validated via Route 53.

**Nameservers:** `ns-461.awsdns-57.com`, `ns-522.awsdns-01.net`, `ns-1093.awsdns-08.org`, `ns-2031.awsdns-61.co.uk`

---

## Network & Security Groups

| Resource           | ID                      | Purpose                                       |
| ------------------ | ----------------------- | --------------------------------------------- |
| VPC                | `vpc-09a6870488b73260e` | 10.0.0.0/20, us-east-1                        |
| ALB + ECS SG       | `sg-08e5864c53710a095`  | Self-referencing, shared by ALB and ECS tasks |
| RDS SG             | `sg-0925439b428efdf13`  | Allows port 5432 from ECS SG                  |
| SM VPC Endpoint SG | `sg-0ddf2cd67fa1b09f0`  | Allows port 443 from ECS SG                   |

### Subnets

The VPC has separate public and private subnets in each AZ. Internet-facing ALBs **must** live in public subnets (route 0.0.0.0/0 → IGW). ECS tasks and RDS live in private subnets (route 0.0.0.0/0 → NAT).

| Subnet ID                  | AZ         | CIDR        | Type    | Route 0.0.0.0/0       | Used by              |
| -------------------------- | ---------- | ----------- | ------- | --------------------- | -------------------- |
| `subnet-022c0065046782a64` | us-east-1a | 10.0.0.0/24 | Public  | igw-071992d39cf002394 | ALB ENI (us-east-1a) |
| `subnet-018a8199c40f7ed73` | us-east-1b | 10.0.3.0/24 | Public  | igw-071992d39cf002394 | ALB ENI (us-east-1b) |
| `subnet-082c94f0897298f6e` | us-east-1a | 10.0.1.0/24 | Private | nat-02f376c5d696b61ff | ECS tasks, RDS       |
| `subnet-096b774ed307c85ed` | us-east-1b | 10.0.2.0/24 | Private | nat-02f376c5d696b61ff | ECS tasks, RDS       |

> **Historical note (2026-05-24):** The ALB was previously placed across one public (`subnet-022c...`) and one private (`subnet-096b...`) subnet. The private subnet's lack of an IGW route caused TCP connections to ~50% of incoming requests (those routed by Route 53 to the bad ENI's public IP) to time out for ~75 seconds before retrying via the working IP. AWS does not reject the misconfiguration at create time. The fix was to create `subnet-018a8199c40f7ed73` as a true public subnet in us-east-1b and swap the ALB to use it via `aws elbv2 set-subnets`. **Never put an internet-facing ALB in a subnet whose default route is a NAT Gateway.**

### Route Tables

| Route Table             | Routes (excluding `local`)          | Associated Subnets             |
| ----------------------- | ----------------------------------- | ------------------------------ |
| `rtb-0cc1e4d41c2264bfc` | 0.0.0.0/0 → `igw-071992d39cf002394` | Both public subnets (1a + 1b)  |
| `rtb-0989410e3b8f596fc` | 0.0.0.0/0 → `nat-02f376c5d696b61ff` | Both private subnets (1a + 1b) |

---

## Monitoring & Health Checks

### ALB Target Groups

| Service | Target Group                                       | Health Check      | Interval |
| ------- | -------------------------------------------------- | ----------------- | -------- |
| API     | `spotterspace-dev-api-tg` (`.../105538bfd82988b2`) | `GET /health`     | 30s      |
| Web     | `spotterspace-dev-web-tg` (`.../53bffb7b973906cb`) | `GET /api/health` | 30s      |

### CloudWatch Logs

```bash
aws logs tail /ecs/spotterspace-dev/api --since 30m --region us-east-1
aws logs tail /ecs/spotterspace-dev/web --since 30m --region us-east-1
```

### Check Target Health

```bash
aws elbv2 describe-target-health \
  --target-group-arn arn:aws:elasticloadbalancing:us-east-1:654654553862:targetgroup/spotterspace-dev-api-tg/105538bfd82988b2 \
  --region us-east-1

aws elbv2 describe-target-health \
  --target-group-arn arn:aws:elasticloadbalancing:us-east-1:654654553862:targetgroup/spotterspace-dev-web-tg/53bffb7b973906cb \
  --region us-east-1
```

### CloudWatch Alarms

| Alarm                                   | Catches                                                                 | Threshold                        |
| --------------------------------------- | ----------------------------------------------------------------------- | -------------------------------- |
| `spotterspace-dev-orphan-fargate-tasks` | Zombie one-off `aws ecs run-task` invocations that don't self-terminate | TaskCount > 3 for 1h             |
| `spotterspace-dev-api-no-healthy-hosts` | API target group with zero healthy hosts (service replacement gone bad) | HealthyHostCount < 1 for 3min    |
| `spotterspace-dev-web-no-healthy-hosts` | Web target group with zero healthy hosts                                | HealthyHostCount < 1 for 3min    |
| `spotterspace-dev-api-unhealthy-hosts`  | Stale unhealthy ENI registrations (orphan task IPs, AZ asymmetry)       | UnHealthyHostCount > 0 for 15min |
| `spotterspace-dev-web-unhealthy-hosts`  | Same as api but for web target group                                    | UnHealthyHostCount > 0 for 15min |

The orphan-fargate-tasks alarm uses `ECS/ContainerInsights TaskCount` (cluster-level), not `RunningTaskCount` (which is only emitted per-service and so cluster-only filters never receive data). Container Insights must remain enabled on the cluster. To re-enable if disabled:

```bash
aws ecs update-cluster-settings --cluster spotterspace-cluster \
  --settings name=containerInsights,value=enabled --region us-east-1
```

#### Baseline (2026-05-24, 2h window)

`TaskCount` stayed between 2 and 3 across 120 one-minute datapoints with `desiredCount: 1+1` (Min=2, Max=3, Avg=2.05). The Max=3 was a brief deploy blip where a new task started before the old one stopped. This validates `> 3 for 1h` as the correct threshold: no false positives on normal deploys, but the 1h evaluation window catches any task that fails to self-terminate. Re-run the baseline in 1-2 weeks once more data has accumulated:

```bash
aws cloudwatch get-metric-statistics --region us-east-1 --no-cli-pager \
  --namespace ECS/ContainerInsights --metric-name TaskCount \
  --dimensions Name=ClusterName,Value=spotterspace-cluster \
  --start-time "$(date -u -v-7d '+%Y-%m-%dT%H:%M:%SZ')" \
  --end-time "$(date -u '+%Y-%m-%dT%H:%M:%SZ')" \
  --period 3600 --statistics Maximum Average Minimum SampleCount \
  --query 'Datapoints | sort_by(@, &Timestamp)' --output table
```

#### SNS notifications

All five alarms are wired (both `AlarmActions` and `OKActions`) to the SNS topic `arn:aws:sns:us-east-1:654654553862:spotterspace-dev-alarms`. The topic has one email subscription for `robi_sz@yahoo.com`. **The subscription was in `PendingConfirmation` state at the time of writing** — AWS sent a confirmation email; clicking the link inside transitions it to `Confirmed` and notifications begin. To check status:

```bash
aws sns list-subscriptions-by-topic --region us-east-1 --no-cli-pager \
  --topic-arn arn:aws:sns:us-east-1:654654553862:spotterspace-dev-alarms \
  --query 'Subscriptions[].{Endpoint:Endpoint,Protocol:Protocol,SubscriptionArn:SubscriptionArn}' --output table
```

A `SubscriptionArn` value starting with `arn:aws:sns:...` (rather than the literal string `PendingConfirmation`) means the subscription is active.

These alarms and the SNS topic were created via the AWS CLI directly on 2026-05-24 because of pre-existing drift between `infrastructure/lib/spotterspace-stack.ts` and the live CloudFormation stack (see [CDK Drift Warning](#cdk-drift-warning) below). The CDK source has since been updated to mirror them, but `cdk deploy` will still fail with "alarm already exists" until someone runs `cdk import` to adopt them under CloudFormation management. Until then, check alarm status from the console or:

```bash
aws cloudwatch describe-alarms --alarm-name-prefix spotterspace-dev- \
  --region us-east-1 --no-cli-pager \
  --query 'MetricAlarms[].{Name:AlarmName,State:StateValue}' --output table
```

### ECR Image Lifecycle

Both ECR repositories (`spotterspace-dev-api`, `spotterspace-dev-web`) have a lifecycle policy that retains only the most recent 10 images. Older images expire automatically. To inspect:

```bash
aws ecr get-lifecycle-policy --repository-name spotterspace-dev-api \
  --region us-east-1 --no-cli-pager --query lifecyclePolicyText --output text
```

To re-apply (the policy JSON):

```bash
aws ecr put-lifecycle-policy --repository-name spotterspace-dev-api \
  --region us-east-1 --no-cli-pager \
  --lifecycle-policy-text '{"rules":[{"rulePriority":1,"description":"Keep last 10 images","selection":{"tagStatus":"any","countType":"imageCountMoreThan","countNumber":10},"action":{"type":"expire"}}]}'
```

### CDK Drift Warning

> **Do not run `cdk deploy` without first running `cdk diff` and reviewing every change.** Reconciled on 2026-05-24: HTTP/web/API listener actions in CDK source now use `forward` (matching live), `WEB_BASE_URL` env var removed from the web task definition (it never reached prod because GitHub Actions copies env from previous task def revisions), and the CloudWatch Alarms section was added to CDK. After reconciliation `cdk diff` reports only image-tag deltas on `ApiTaskDef` and `WebTaskDef`, which is expected because CI manages task def images out-of-band via `aws ecs register-task-definition`.

Three follow-up items remain before `cdk deploy` is safe again:

1. The five CloudWatch alarms and the `spotterspace-dev-alarms` SNS topic exist in AWS but not in CloudFormation. Running `cdk deploy` will fail with "already exists" errors until they are adopted via `cdk import`. Until then, treat them as CLI-managed.
2. ~~The HTTP→HTTPS redirect was never deployed.~~ Done 2026-09-19 via `scripts/alb-https-apex.sh`, and CDK source updated to match (`HttpListener`, `ApiListenerRule`, `WebListenerRule` now redirect). Those three are CloudFormation-owned, so the next `cdk deploy` simply confirms them. The same change **added two resources outside CloudFormation** — the `:443` apex redirect rule (`HttpsApexRedirectRule`) and the apex A record (`ApexAlbAliasRecord`). Like the alarms in item 1, they are in CDK source but must be adopted with `cdk import` before `cdk deploy`, or it will fail with a name/priority conflict.
3. `WEB_BASE_URL` (and any other env var added to CDK) will be silently dropped on next deploy because `deploy.yml` registers task definitions by copying env vars from the previous revision. Either move task definition management entirely to CDK, or update `deploy.yml` to read env vars from a CDK CfnOutput.

### ECS Task Status

```bash
aws ecs list-tasks --cluster spotterspace-cluster --region us-east-1 --desired-status RUNNING --no-cli-pager

aws ecs describe-tasks --cluster spotterspace-cluster --tasks TASK_ARN --region us-east-1 --no-cli-pager
```

---

## Troubleshooting

### ECS Redeployment Doesn't Pick Up New Image

**Cause:** Task definition is pinned to a specific tag instead of `:latest`.

**Fix:** Register a new task definition revision pointing to `:latest`. See [Task Definition Management](#task-definition-management).

### API Can't Connect to RDS

1. Verify ECS tasks are in private subnets with NAT gateway
2. Check RDS SG (`sg-0925439b428efdf13`) allows inbound 5432 from ECS SG (`sg-08e5864c53710a095`)
3. Check Secrets Manager contains the correct `DATABASE_URL` with the RDS endpoint
4. Verify Secrets Manager VPC Endpoint SG (`sg-0ddf2cd67fa1b09f0`) allows inbound 443 from ECS SG

### CloudShell Can't Connect to RDS

**This is expected.** CloudShell runs outside the VPC. RDS is only accessible from within the VPC (ECS tasks). See [Database Access](#database-access).

### DNS_PROBE_FINISHED_NXDOMAIN

**Fix:** Flush local DNS cache:

```bash
# macOS
sudo dscacheutil -flushcache && sudo killall -HUP mDNSResponder
```

### Secrets Manager: "Secret Not Found"

**Check:** The prefix is `spotterhub/`, NOT `spotterspace/`:

```bash
aws secretsmanager list-secrets --query "SecretList[].Name" --output table
```

### Failed Migration Row in \_prisma_migrations (P3009)

**Symptoms:** API containers crash on startup with `P3009: migrate found failed migrations in the target database`. ALB returns 503 because no healthy targets exist, but a long-lived orphan task from a previous revision may still be serving traffic, masking the crash loop.

**Cause:** A row exists in `_prisma_migrations` with `finished_at = NULL` and `logs` containing an error. This happens when a migration file is deleted from the codebase after it partially ran or failed in production.

**Fix:** Run `prisma migrate resolve --rolled-back <migration_name>` inside the VPC via a one-off ECS task (see Emergency Schema Repair below). This marks the row as rolled back and allows subsequent `prisma migrate deploy` calls to proceed.

```bash
# One-off command to pass as the container override:
npx prisma migrate resolve --rolled-back 20260406123505_init \
  --schema packages/db/prisma/schema.prisma && echo DONE
```

After the one-off task exits successfully, force a new deployment of the api service. The regular `docker-entrypoint.sh` path will succeed on the next start.

### Missing Database Tables (Migration Drift)

**Symptoms:** ECS API tasks crash on startup with Prisma errors like `P3005` ("table does not exist") or `The table public.users does not exist`. ALB returns 503 because no healthy targets are available.

**Cause:** Tables were dropped or lost, but `_prisma_migrations` still records them as applied. `prisma migrate deploy` sees all migrations as applied and does nothing.

**Fix:**

1. Use the **Emergency Schema Repair** procedure in [Database Access](#emergency-schema-repair-via-ecs-run-task) to run `prisma db push --accept-data-loss` inside the VPC, recreating all missing tables.
2. Re-baseline the migration history with `prisma migrate resolve --applied` for each migration.
3. Force a new ECS deployment to restart the API tasks.

```bash
# Verify recovery
aws ecs describe-services --cluster spotterspace-cluster \
  --services spotterspace-dev-api --region us-east-1 --no-cli-pager \
  --query 'services[0].{Running:runningCount,Desired:desiredCount,Status:deployments[0].rolloutState}'

curl -s https://api.spotterspace.com/health
```

---

## File Reference

| File                               | Description                                                                         |
| ---------------------------------- | ----------------------------------------------------------------------------------- |
| `.github/workflows/deploy.yml`     | Deploy workflow (Docker build + push to ECR + ECS redeploy)                         |
| `.github/workflows/ci.yml`         | CI workflow (lint → typecheck → test → build)                                       |
| `apps/api/Dockerfile`              | API Docker build (multi-stage, Node 20 Alpine)                                      |
| `apps/api/docker-entrypoint.sh`    | API container startup (runs migrations before server)                               |
| `apps/api/src/index.ts`            | API entry point (secret loading, migrations, /seed & /admin/verify-email endpoints) |
| `apps/web/Dockerfile`              | Web Docker build (Next.js standalone)                                               |
| `apps/web/next.config.ts`          | Next.js config (standalone output, /api/graphql rewrite, S3 patterns)               |
| `packages/db/prisma/schema.prisma` | Prisma schema (database models)                                                     |
| `packages/db/prisma/seed.ts`       | Database seed (test users, airports, sample data)                                   |
| `DEPLOYMENT_STATUS.md`             | This file                                                                           |
