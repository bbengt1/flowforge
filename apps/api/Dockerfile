# syntax=docker/dockerfile:1
# Control-plane API image. Runtime UID/GID 65532 is the shared FlowForge
# non-root identity (web image aligns to the same UID).

FROM golang:1.26-alpine AS build
WORKDIR /src
ENV GOTOOLCHAIN=local
ENV CGO_ENABLED=0

RUN apk add --no-cache ca-certificates git

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
    -o /out/worker ./cmd/worker

FROM alpine:3.20
RUN addgroup -S -g 65532 app && adduser -S -u 65532 -G app app \
 && apk add --no-cache ca-certificates tzdata \
 && mkdir -p /tmp && chown 65532:65532 /tmp && chmod 1777 /tmp

COPY --from=build --chown=65532:65532 /out/api /usr/local/bin/api
COPY --from=build --chown=65532:65532 /out/migrate /usr/local/bin/migrate
COPY --from=build --chown=65532:65532 /out/worker /usr/local/bin/worker

USER 65532:65532
EXPOSE 8080

LABEL org.opencontainers.image.source="https://github.com/bbengt1/flowforge" \
      org.opencontainers.image.title="flowforge-api" \
      org.opencontainers.image.description="FlowForge control-plane API"

# CMD (not ENTRYPOINT) so compose `command:` can run /usr/local/bin/migrate
# or /usr/local/bin/worker. The worker binary is local/dev only — do not
# run it from deploy/k8s.
# Run this image with a read-only root filesystem, dropped capabilities,
# no-new-privileges, and resource limits (see docker-compose.yml and deploy/k8s).
CMD ["/usr/local/bin/api"]
