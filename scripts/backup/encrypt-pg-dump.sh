#!/usr/bin/env bash
# Encrypted pg_dump from the compose postgres service.
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

docker compose exec -T -e PGPASSWORD="$POSTGRES_PASSWORD" "$BACKUP_SOURCE_SERVICE" \
  pg_dump -U "$POSTGRES_USER" -d "$POSTGRES_DB" --no-owner --no-acl \
  | openssl enc -aes-256-cbc -pbkdf2 -salt -pass env:BACKUP_ENCRYPTION_KEY \
  > "$outfile"

echo "wrote encrypted dump $outfile"
