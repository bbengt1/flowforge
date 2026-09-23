# syntax=docker/dockerfile:1
# Encrypted Postgres backup image for deploy/k8s CronJob (G.1.4).
# Runtime UID/GID 65532 matches API / web / runner.
#
# Base pin is the multi-arch index digest for alpine:3.20.
# Refresh: docs/deployment.md#refreshing-dockerfile-base-digests.
# Build from the repository root:
#   docker build -f scripts/backup/Dockerfile -t ghcr.io/bbengt1/flowforge-backup:foundation .

FROM alpine:3.24@sha256:294b683cb724975bec92580e1e685676bd4b50bda910ddb8c51d4cabeaec77e6

RUN addgroup -S -g 65532 app && adduser -S -u 65532 -G app app \
 && apk add --no-cache \
      bash \
      ca-certificates \
      postgresql16-client \
      aws-cli \
      python3 \
      py3-cryptography \
 && mkdir -p /tmp /backups /usr/local/lib/flowforge \
 && chown 65532:65532 /tmp /backups \
 && chmod 1777 /tmp

COPY scripts/backup/common.sh /usr/local/bin/common.sh
COPY scripts/backup/run-encrypted-backup.sh /usr/local/bin/run-encrypted-backup
COPY scripts/backup/archive-wal.sh /usr/local/bin/archive-wal
COPY scripts/backup/receive-wal.sh /usr/local/bin/receive-wal
COPY scripts/backup/pitr-basebackup.sh /usr/local/bin/pitr-basebackup
COPY scripts/backup/pitr-restore.sh /usr/local/bin/pitr-restore
COPY scripts/backup/aead.py /usr/local/lib/flowforge/aead.py
COPY scripts/backup/manifest.py /usr/local/lib/flowforge/manifest.py
RUN chmod 0555 \
      /usr/local/bin/common.sh \
      /usr/local/bin/run-encrypted-backup \
      /usr/local/bin/archive-wal \
      /usr/local/bin/receive-wal \
      /usr/local/bin/pitr-basebackup \
      /usr/local/bin/pitr-restore \
      /usr/local/lib/flowforge/aead.py \
      /usr/local/lib/flowforge/manifest.py

USER 65532:65532

LABEL org.opencontainers.image.source="https://github.com/bbengt1/flowforge" \
      org.opencontainers.image.title="flowforge-backup" \
      org.opencontainers.image.description="FlowForge encrypted Postgres backup, integrity manifest, and WAL archive"

# CronJob overrides command. Default is a no-op so accidental starts fail closed
# without a DSN / key rather than dumping to stdout.
CMD ["/usr/local/bin/run-encrypted-backup"]
