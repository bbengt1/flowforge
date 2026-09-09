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
RUN go build -trimpath -ldflags="-s -w" -o /out/api ./cmd/api \
 && go build -trimpath -ldflags="-s -w" -o /out/migrate ./cmd/migrate

FROM alpine:3.20
RUN addgroup -S -g 65532 app && adduser -S -u 65532 -G app app \
 && apk add --no-cache ca-certificates tzdata \
 && mkdir -p /tmp && chown 65532:65532 /tmp && chmod 1777 /tmp

COPY --from=build --chown=65532:65532 /out/api /usr/local/bin/api
COPY --from=build --chown=65532:65532 /out/migrate /usr/local/bin/migrate

USER 65532:65532
EXPOSE 8080

LABEL org.opencontainers.image.source="https://github.com/bbengt1/flowforge" \
      org.opencontainers.image.title="flowforge-api" \
      org.opencontainers.image.description="FlowForge control-plane API"

# CMD (not ENTRYPOINT) so compose `command:` can run /usr/local/bin/migrate.
# Run this image with a read-only root filesystem, dropped capabilities,
# no-new-privileges, and resource limits (see docker-compose.yml and deploy/k8s).
CMD ["/usr/local/bin/api"]
