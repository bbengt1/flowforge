# FlowForge API image — E1.1 placeholder
#
# Owner: jonny
# Replace this stub with a multi-stage Go build that produces a non-root
# binary listening on :8080 (or $API_ADDR).
#
# Compose contract (see docker-compose.yml, service `api`):
#   build.context    = ./apps/api
#   build.dockerfile = Dockerfile
#   published port   = 8080
#   env              = DATABASE_URL, API_ADDR, POSTGRES_*
#
# Required once the control plane lands (docs/reference/backend-api-map.md):
#   GET /api/v1/health     → 200 {"status":"ok"}
#   GET /api/v1/readiness  → 200 {"status":"ready"} after migrations
#
# Suggested layout (not created here):
#   apps/api/cmd/api/main.go
#   apps/api/go.mod
#   apps/api/internal/...
#
# This placeholder keeps `docker compose up --build` able to start the
# api service until that code exists. It does not implement the API.

FROM alpine:3.21

WORKDIR /app

RUN addgroup -S flowforge && adduser -S flowforge -G flowforge \
  && echo "Replace apps/api with the Go control plane (listen :8080)." > /app/PLACEHOLDER

USER flowforge
EXPOSE 8080

CMD ["sh", "-c", "echo 'flowforge-api placeholder: waiting for jonny Go control plane on :8080'; sleep infinity"]
