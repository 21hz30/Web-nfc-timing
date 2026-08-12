# Alibaba Cloud Shanghai Migration Trial

This deployment keeps the existing timing UI and API contract while replacing the
managed Supabase runtime with components that can run inside one Alibaba Cloud VPC:

- Alibaba Cloud RDS PostgreSQL 17 stores the timing data.
- PostgREST exposes the existing tables and RPC functions only to the API container.
- The existing Deno `timing-api` remains the public application API.
- Nginx serves the static pages and proxies same-origin `/api/*` requests.
- An Alibaba Cloud load balancer terminates HTTPS before forwarding to port 8080.

The production Supabase project remains untouched until an explicit cutover.

## Local Validation

Generate a local secret file, then copy the public browser key from `timing-api.js`
into `TIMING_PUBLIC_KEY` in that file:

```bash
TIMING_PUBLIC_KEY=<key-from-timing-api.js> node \
  deploy/aliyun/scripts/generate-secrets.mjs --output deploy/aliyun/.env
docker compose --env-file deploy/aliyun/.env \
  -f deploy/aliyun/compose.local.yml up --build
```

Open `http://127.0.0.1:8789/` and verify:

```text
GET /api/health
GET /api/races
GET /api/leaderboard?raceId=hoka-race-hz
```

The local stack starts with the schema and seed migrations but does not contain the
production participant or timing data. It sets `TIMING_ENVIRONMENT=development`.
The ECS and offline production compose files set `TIMING_ENVIRONMENT=production`.

## Shanghai Test Resources

Use a separate test VPC in `cn-shanghai`. The initial recommended footprint is:

- RDS PostgreSQL 17, high-availability edition, private endpoint only.
- One ECS test instance in the same VPC and zone, with Docker Compose installed.
- One ALB/CLB listener on HTTPS 443 forwarding to ECS port 8080.
- A test subdomain and Alibaba Cloud Certificate Management Service certificate.
- Security groups that expose only 443 publicly; PostgreSQL and PostgREST stay private.

Do not put RDS credentials, JWT secrets, database dumps, or certificates in Git.

## Schema Migration

On ECS, create `deploy/aliyun/.env` from `env.example`, set the RDS internal URLs,
then run:

```bash
docker compose --env-file deploy/aliyun/.env \
  -f deploy/aliyun/compose.ecs.yml run --rm migrate
```

`migrate.sh` creates the PostgREST roles, installs `pgcrypto`, applies every existing
Supabase migration in order, and grants the private API role access to the schema.

## Data Copy

Data copy requires a source Supabase PostgreSQL connection URL and the empty target
RDS connection URL. Run the copy only after the schema migration succeeds:

```bash
docker run --rm \
  --env-file deploy/aliyun/.env \
  -v "$PWD/deploy/aliyun/scripts:/scripts:ro" \
  postgres:17.6-alpine /bin/sh /scripts/clone-data.sh
```

The script creates a temporary data-only archive, restores it into RDS, then removes
the temporary archive. It never changes or locks the source database for writes. It
does truncate the test target first, so `ALLOW_EMPTY_TARGET_RESET=YES` is required and
must never be set for a database that contains unique production writes.

For the final production cutover, briefly stop writes, repeat the data copy into a
fresh target, verify row counts, and then change the domain or `/api/*` origin. Keep
the Supabase route available for rollback until the first event has completed on the
Shanghai stack.

## ECS Start

After migration and data copy:

```bash
docker compose --env-file deploy/aliyun/.env \
  -f deploy/aliyun/compose.ecs.yml up -d --build postgrest timing-api web
```

The load balancer health check should use `/api/health` and require HTTP 200.

## Offline ECS Bundle

Use the offline bundle when the ECS cannot reach Docker Hub. Build it on a Mac
or CI runner that can access the registry:

```bash
deploy/aliyun/scripts/build-offline-bundle.sh
```

The script builds the application for `linux/amd64` and writes three ignored
files to `deploy/aliyun/dist/`:

```text
src-timing-images-linux-amd64.tar.gz
src-timing-deploy-linux-amd64.tar.gz
SHA256SUMS
```

Upload all three files to the ECS. Verify and install them without contacting a
container registry:

```bash
cd /opt/src-timing-upload
sha256sum --check SHA256SUMS
gzip --decompress --stdout src-timing-images-linux-amd64.tar.gz | docker load
tar -xzf src-timing-deploy-linux-amd64.tar.gz -C /opt
cd /opt/src-counting/deploy/aliyun
cp env.example .env
```

Set the RDS private connection values and generated secrets in `.env`, then
validate and start the offline stack:

```bash
docker compose --env-file .env --env-file release.env -f compose.offline.yml config
docker compose --env-file .env --env-file release.env -f compose.offline.yml up -d
```

`compose.offline.yml` uses `pull_policy: never`, publishes only host port 80,
and limits the resident services to less than 700 MB of configured memory. Add
HTTPS at the CDN or load-balancer layer before using Web NFC on phones.

### Offline Updates And Rollback

Each bundle contains a timestamped application image tag in `release.env`.
Before extracting a later deploy bundle, preserve the active release file:

```bash
cd /opt/src-counting/deploy/aliyun
cp release.env release.env.previous
```

Load the new image archive, extract the new deploy bundle, and apply database
migrations before replacing the resident services:

```bash
docker compose --env-file .env --env-file release.env -f compose.offline.yml run --rm migrate
docker compose --env-file .env --env-file release.env -f compose.offline.yml up -d --no-build
```

The RDS data is not stored in the application images. To roll back application
code, keep the previous images and start the stack with the preserved tag:

```bash
docker compose --env-file .env --env-file release.env.previous -f compose.offline.yml up -d --no-build
```

Do not run `docker image prune` until the new release has passed a complete race
workflow test and the rollback window has ended.
