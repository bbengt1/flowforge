# FlowForge web image. Compose build context is ./apps/web
# (docker-compose.yml service `web`).
#
# UID/GID 65532 matches apps/api. Runtime hardening that cannot live in the
# image itself is applied by compose/K8s: read-only root, tmpfs on /tmp and
# /app/.next/cache, cap_drop ALL, no-new-privileges, resource limits.
# Digest pin is the multi-arch index for node:22-alpine (see docs/deployment.md).

FROM node:22-alpine@sha256:c610fcdfb1d5b4740dd70c284ed3cb16bb857e0f7166196e36a5501df7a3aa32 AS base
RUN corepack enable && corepack prepare pnpm@10.33.3 --activate
WORKDIR /app

FROM base AS deps
COPY package.json ./
RUN pnpm install

FROM deps AS build
ARG NEXT_PUBLIC_API_URL=http://localhost:8080
ENV NEXT_PUBLIC_API_URL=$NEXT_PUBLIC_API_URL
ENV DOCKER_BUILD=1
ENV NEXT_TELEMETRY_DISABLED=1
COPY . .
RUN pnpm build

FROM node:22-alpine@sha256:c610fcdfb1d5b4740dd70c284ed3cb16bb857e0f7166196e36a5501df7a3aa32 AS runner
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
RUN addgroup -S -g 65532 flowforge \
 && adduser -S -u 65532 -G flowforge -H -D flowforge \
 && mkdir -p /tmp /app/.next/cache \
 && chown -R 65532:65532 /tmp /app

COPY --from=build --chown=65532:65532 /app/public ./public
COPY --from=build --chown=65532:65532 /app/.next/standalone ./
COPY --from=build --chown=65532:65532 /app/.next/static ./.next/static

USER 65532:65532
EXPOSE 3000
CMD ["node", "server.js"]
