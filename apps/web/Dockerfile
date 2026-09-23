# FlowForge web image. Compose build context is the repository root
# (`docker-compose.yml` service `web`, dockerfile: apps/web/Dockerfile)
# so this stage can copy the workspace pnpm-lock.yaml.
#
# UID/GID 65532 matches apps/api. Runtime hardening that cannot live in the
# image itself is applied by compose/K8s: read-only root, tmpfs on /tmp and
# /app/apps/web/.next/cache, cap_drop ALL, no-new-privileges, resource limits.
# Digest pin is the multi-arch index for node:25-alpine
# (Node 25.9.0 on Alpine 3.23; see docs/deployment.md#refreshing-dockerfile-base-digests).

FROM node:25-alpine@sha256:bdf2cca6fe3dabd014ea60163eca3f0f7015fbd5c7ee1b0e9ccb4ced6eb02ef4 AS base
# Node 25 no longer ships corepack. Pin the same pnpm the lockfile expects.
RUN npm install -g pnpm@10.33.3
WORKDIR /app

FROM base AS deps
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml .pnpmfile.cjs ./
COPY apps/web/package.json ./apps/web/package.json
RUN pnpm install --frozen-lockfile

FROM deps AS build
ARG NEXT_PUBLIC_API_URL=http://localhost:8080
ENV NEXT_PUBLIC_API_URL=$NEXT_PUBLIC_API_URL
ENV DOCKER_BUILD=1
ENV NEXT_TELEMETRY_DISABLED=1
COPY apps/web ./apps/web
RUN pnpm --filter @flowforge/web build

FROM node:25-alpine@sha256:bdf2cca6fe3dabd014ea60163eca3f0f7015fbd5c7ee1b0e9ccb4ced6eb02ef4 AS runner
WORKDIR /app
ENV NODE_ENV=production
ENV PORT=3000
ENV HOSTNAME=0.0.0.0
ENV HOME=/tmp
ENV TMPDIR=/tmp
ENV NEXT_PUBLIC_API_URL=http://localhost:8080
ENV API_INTERNAL_URL=http://api:8080
ENV NEXT_TELEMETRY_DISABLED=1

# 65532 matches apps/api (non-root). Pre-create tmpfs mount points so a
# read-only root filesystem can still serve the standalone Next server.
# Workspace standalone output lives under apps/web/.
# The standalone server only runs `node`. node:25-alpine bundles npm's
# tar 7.5.11 (CVE-2026-59873, fixed in 7.5.19). That copy is not in
# pnpm-lock.yaml. Drop npm (and corepack, which Node 25 does not ship)
# so the runtime image does not ship it. Build stages above still use
# npm only to install pnpm.
# The pinned index (Alpine 3.23) ships libssl3 3.5.6-r0 (CVE-2026-14456,
# fixed in 3.5.8-r0). Upgrade those two packages so the HIGH image gate
# can pass. The build fails if Alpine v3.23 no longer publishes that version.
RUN apk add --no-cache 'libcrypto3=3.5.8-r0' 'libssl3=3.5.8-r0' \
 && addgroup -S -g 65532 flowforge \
 && adduser -S -u 65532 -G flowforge -H -D flowforge \
 && rm -rf /usr/local/lib/node_modules/npm /usr/local/lib/node_modules/corepack \
 && rm -f /usr/local/bin/npm /usr/local/bin/npx /usr/local/bin/corepack \
 && mkdir -p /tmp /app/apps/web/.next/cache \
 && chown -R 65532:65532 /tmp /app

COPY --from=build --chown=65532:65532 /app/apps/web/public ./apps/web/public
COPY --from=build --chown=65532:65532 /app/apps/web/.next/standalone ./
COPY --from=build --chown=65532:65532 /app/apps/web/.next/static ./apps/web/.next/static

USER 65532:65532
EXPOSE 3000
CMD ["node", "apps/web/server.js"]
