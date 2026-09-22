#!/usr/bin/env bash
# Encrypted pg_dump from the compose postgres service.
# Sibling for Kubernetes / DSN: scripts/backup/run-encrypted-backup.sh
# AEAD format FFB1 (AES-256-GCM + PBKDF2) via scripts/backup/aead.py.
# Never prints BACKUP_ENCRYPTION_KEY, DATABASE_URL, or POSTGRES_PASSWORD.
#
#   export POSTGRES_PASSWORD=...
#   export BACKUP_ENCRYPTION_KEY=...   # passphrase; production should wrap this via KMS
#   bash scripts/backup/encrypt-pg-dump.sh [outfile]
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$ROOT"

: "${POSTGRES_USER:=flowforge}"
: "${POSTGRES_DB:=flowforge}"
: "${POSTGRES_PASSWORD:?POSTGRES_PASSWORD is required}"
: "${BACKUP_ENCRYPTION_KEY:?BACKUP_ENCRYPTION_KEY is required}"
: "${BACKUP_SOURCE_SERVICE:=postgres}"

outfile="${1:-flowforge-$(date -u +%Y%m%dT%H%M%SZ).sql.enc}"

umask 077
docker compose exec -T -e PGPASSWORD="$POSTGRES_PASSWORD" "$BACKUP_SOURCE_SERVICE" \
  pg_dump -U "$POSTGRES_USER" -d "$POSTGRES_DB" --no-owner --no-acl \
  | python3 "$ROOT/scripts/backup/aead.py" seal \
  > "$outfile"

if [[ ! -s "$outfile" ]]; then
  echo "encrypted dump is empty" >&2
  rm -f "$outfile"
  exit 1
fi

echo "wrote encrypted dump $outfile format=FFB1"
