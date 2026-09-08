# FlowForge web image. Compose build context is ./apps/web
# (docker-compose.yml service `web`).
FROM node:22-alpine AS base
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

FROM node:22-alpine AS runner
WORKDIR /app
ENV NODE_ENV=production
ENV PORT=3000
ENV HOSTNAME=0.0.0.0
ENV NEXT_PUBLIC_API_URL=http://localhost:8080
ENV API_INTERNAL_URL=http://api:8080
ENV NEXT_TELEMETRY_DISABLED=1

RUN addgroup -S flowforge && adduser -S flowforge -G flowforge

COPY --from=build /app/public ./public
COPY --from=build --chown=flowforge:flowforge /app/.next/standalone ./
COPY --from=build --chown=flowforge:flowforge /app/.next/static ./.next/static

USER flowforge
EXPOSE 3000
CMD ["node", "server.js"]
