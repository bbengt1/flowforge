# FlowForge web image. Build context is the repository root
# (see docker-compose.yml service `web`).
FROM node:22-alpine AS base
RUN corepack enable && corepack prepare pnpm@10.33.3 --activate
WORKDIR /repo

FROM base AS deps
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml ./
COPY apps/web/package.json apps/web/package.json
RUN pnpm install --filter @flowforge/web --frozen-lockfile

FROM deps AS build
ARG NEXT_PUBLIC_API_URL=http://localhost:8080
ENV NEXT_PUBLIC_API_URL=$NEXT_PUBLIC_API_URL
ENV DOCKER_BUILD=1
ENV NEXT_TELEMETRY_DISABLED=1
COPY apps/web apps/web
RUN pnpm --filter @flowforge/web build

FROM node:22-alpine AS runner
WORKDIR /app
ENV NODE_ENV=production
ENV PORT=3000
ENV HOSTNAME=0.0.0.0
ENV NEXT_PUBLIC_API_URL=http://localhost:8080
ENV API_INTERNAL_URL=http://api:8080

RUN addgroup -S flowforge && adduser -S flowforge -G flowforge

COPY --from=build /repo/apps/web/public ./apps/web/public
COPY --from=build --chown=flowforge:flowforge /repo/apps/web/.next/standalone ./
COPY --from=build --chown=flowforge:flowforge /repo/apps/web/.next/static ./apps/web/.next/static

USER flowforge
EXPOSE 3000
CMD ["node", "apps/web/server.js"]
