# syntax=docker/dockerfile:1
# Control-plane API image. Runtime UID/GID 65532 is the shared FlowForge
# non-root identity (web image aligns to the same UID).
#
# Base pins are the multi-arch index digests for golang:1.26-alpine and
# alpine:3.24. Refresh: docs/deployment.md#refreshing-dockerfile-base-digests.

FROM golang:1.26-alpine@sha256:8ac98ca534ac3f51e1f420a1dd2c15e74c75cfa0f23f3ad27eb5d7236c349a0c AS build
WORKDIR /src
ENV GOTOOLCHAIN=local
ENV CGO_ENABLED=0

RUN apk add --no-cache ca-certificates

COPY go.mod go.sum ./
RUN go mod download

COPY . .
# G.0.10 / C1: bake non-secret identity into the binary. Compose and CI
# pass BUILD_SHA / BUILD_VERSION as build args (see docker-compose.yml
# and .github/workflows/smoke.yml). Missing args stay "unknown" / "dev"
# and never fail the image build or GET /api/v1/health.
ARG BUILD_SHA=unknown
ARG BUILD_VERSION=dev
RUN go build -trimpath \
    -ldflags="-s -w -X github.com/bbengt1/flowforge/apps/api/internal/buildinfo.Version=${BUILD_VERSION} -X github.com/bbengt1/flowforge/apps/api/internal/buildinfo.SHA=${BUILD_SHA}" \
    -o /out/api ./cmd/api \
 && go build -trimpath \
    -ldflags="-s -w -X github.com/bbengt1/flowforge/apps/api/internal/buildinfo.Version=${BUILD_VERSION} -X github.com/bbengt1/flowforge/apps/api/internal/buildinfo.SHA=${BUILD_SHA}" \
    -o /out/migrate ./cmd/migrate \
 && go build -trimpath \
    -ldflags="-s -w -X github.com/bbengt1/flowforge/apps/api/internal/buildinfo.Version=${BUILD_VERSION} -X github.com/bbengt1/flowforge/apps/api/internal/buildinfo.SHA=${BUILD_SHA}" \
    -o /out/worker ./cmd/worker \
 && go build -trimpath \
    -ldflags="-s -w -X github.com/bbengt1/flowforge/apps/api/internal/buildinfo.Version=${BUILD_VERSION} -X github.com/bbengt1/flowforge/apps/api/internal/buildinfo.SHA=${BUILD_SHA}" \
    -o /out/runner ./cmd/runner \
 && go build -trimpath \
    -ldflags="-s -w -X github.com/bbengt1/flowforge/apps/api/internal/buildinfo.Version=${BUILD_VERSION} -X github.com/bbengt1/flowforge/apps/api/internal/buildinfo.SHA=${BUILD_SHA}" \
    -o /out/kek-rotate ./cmd/kek-rotate \
 && go build -trimpath \
    -ldflags="-s -w -X github.com/bbengt1/flowforge/apps/api/internal/buildinfo.Version=${BUILD_VERSION} -X github.com/bbengt1/flowforge/apps/api/internal/buildinfo.SHA=${BUILD_SHA}" \
    -o /out/slug-backfill ./cmd/slug-backfill \
 && go build -trimpath -o /out/healthcheck ./cmd/healthcheck

FROM alpine:3.24@sha256:294b683cb724975bec92580e1e685676bd4b50bda910ddb8c51d4cabeaec77e6
RUN addgroup -S -g 65532 app && adduser -S -u 65532 -G app app \
 && apk add --no-cache ca-certificates tzdata \
 && mkdir -p /tmp && chown 65532:65532 /tmp && chmod 1777 /tmp

COPY --from=build --chown=65532:65532 /out/api /usr/local/bin/api
COPY --from=build --chown=65532:65532 /out/migrate /usr/local/bin/migrate
COPY --from=build --chown=65532:65532 /out/worker /usr/local/bin/worker
COPY --from=build --chown=65532:65532 /out/runner /usr/local/bin/runner
COPY --from=build --chown=65532:65532 /out/kek-rotate /usr/local/bin/kek-rotate
COPY --from=build --chown=65532:65532 /out/slug-backfill /usr/local/bin/slug-backfill
COPY --from=build --chown=65532:65532 /out/healthcheck /usr/local/bin/healthcheck

USER 65532:65532
EXPOSE 8080

LABEL org.opencontainers.image.source="https://github.com/bbengt1/flowforge" \
      org.opencontainers.image.title="flowforge-api" \
      org.opencontainers.image.description="FlowForge control-plane API"

# Liveness only (process serving). Does not check PostgreSQL — that is
# GET /api/v1/readiness (k8s readinessProbe). When pid 1 is the API,
# /usr/local/bin/healthcheck calls GET /api/v1/health on port 8080.
# When pid 1 is /usr/local/bin/runner, the local worker, migrate, or
# kek-rotate, the probe succeeds without that port. Compose worker
# still disables this check.
HEALTHCHECK --interval=15s --timeout=3s --start-period=10s --retries=3 \
  CMD ["/usr/local/bin/healthcheck"]

# CMD (not ENTRYPOINT) so compose `command:` can run /usr/local/bin/migrate
# or /usr/local/bin/worker. /usr/local/bin/worker is local/dev only.
# Production uses /usr/local/bin/runner (deploy/k8s). Do not run the
# compose worker from deploy/k8s.
# Run this image with a read-only root filesystem, dropped capabilities,
# no-new-privileges, and resource limits (see docker-compose.yml and deploy/k8s).
CMD ["/usr/local/bin/api"]
