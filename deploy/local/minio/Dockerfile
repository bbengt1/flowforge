# syntax=docker/dockerfile:1
# Local/CI MinIO only. Newest AGPL community tag, built from source.
# quay.io/minio/minio anonymous pull is 401. docker.io/minio/minio
# requires auth. dl.min.io community binaries are HTTP 410. AIStor
# denies S3 without a license. Do not copy this image into deploy/k8s.
#
# Bases match deploy/supply-chain/approved-bases.txt (same digests as
# apps/api/Dockerfile).

FROM golang:1.26-alpine@sha256:8ac98ca534ac3f51e1f420a1dd2c15e74c75cfa0f23f3ad27eb5d7236c349a0c AS build

# AGPL tag RELEASE.2025-10-15T17-29-55Z is a label only. The build
# checks out MINIO_SHA. A moved tag is not in this shallow clone, so
# checkout of the pinned SHA fails the build. Later server images are
# AIStor and refuse unlicensed S3.
ARG MINIO_TAG=RELEASE.2025-10-15T17-29-55Z
ARG MINIO_SHA=9e49d5e7a648f00e26f2246f4dc28e6b07f8c84a

RUN apk add --no-cache ca-certificates git
WORKDIR /src
RUN git clone --depth 1 --branch "${MINIO_TAG}" https://github.com/minio/minio.git . \
	&& git checkout --detach "${MINIO_SHA}" \
	&& test "$(git rev-parse HEAD)" = "${MINIO_SHA}"

ENV CGO_ENABLED=0
ENV GOTOOLCHAIN=local
ENV MINIO_RELEASE=RELEASE
RUN go build -tags kqueue -trimpath \
	-ldflags "$(go run buildscripts/gen-ldflags.go)" \
	-o /out/minio .

FROM alpine:3.24@sha256:294b683cb724975bec92580e1e685676bd4b50bda910ddb8c51d4cabeaec77e6

# UID 65532 matches the other FlowForge images. /data is the named
# volume; its ownership is copied from this directory on first use.
# Busybox wget is already in the base (no extra package).
RUN addgroup -S -g 65532 minio \
	&& adduser -S -u 65532 -G minio -H -h /data minio \
	&& apk add --no-cache ca-certificates \
	&& mkdir -p /data \
	&& chown 65532:65532 /data

COPY --from=build --chown=65532:65532 /out/minio /usr/local/bin/minio
COPY --chown=65532:65532 docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh
RUN chmod 755 /usr/local/bin/docker-entrypoint.sh /usr/local/bin/minio

USER 65532:65532
EXPOSE 9000 9001
VOLUME ["/data"]

# Fail-closed: busybox wget exits non-zero unless /minio/health/ready
# is HTTP 200. The source build does not include mc.
HEALTHCHECK --interval=5s --timeout=5s --start-period=5s --retries=12 \
	CMD wget -q -O /dev/null http://127.0.0.1:9000/minio/health/ready || exit 1

ENTRYPOINT ["/usr/local/bin/docker-entrypoint.sh"]
CMD ["server", "/data", "--console-address", ":9001"]
