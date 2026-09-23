#!/usr/bin/env bash
# Encrypted pg_dump from a Postgres DSN (Kubernetes CronJob / CI).
# Sibling of encrypt-pg-dump.sh (compose exec). AEAD format FFB1
# (AES-256-GCM + PBKDF2) via scripts/backup/aead.py.
#
# Never prints BACKUP_ENCRYPTION_KEY, DATABASE_URL, POSTGRES_PASSWORD,
# or object-store credentials. Ciphertext is authenticated; plaintext
# secrets are not written to the backup blob (whole dump is sealed).
# A sibling FFB1 integrity manifest lists the dump checksum and is
# verified before upload. Tamper fails closed.
#
#   export DATABASE_URL='postgres://…'   # or POSTGRES_* discrete vars
#   export BACKUP_ENCRYPTION_KEY=...
#   # Optional durable landing (required by the k8s CronJob):
#   export BACKUP_S3_BUCKET=...
#   export AWS_ACCESS_KEY_ID=...
#   export AWS_SECRET_ACCESS_KEY=...
#   bash scripts/backup/run-encrypted-backup.sh [outfile]
set -euo pipefail

source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/common.sh"
backup_resolve_tools

: "${BACKUP_ENCRYPTION_KEY:?BACKUP_ENCRYPTION_KEY is required}"

outfile="${1:-}"
if [[ -z "$outfile" ]]; then
  stamp="$(date -u +%Y%m%dT%H%M%SZ)"
  outdir="${BACKUP_OUTDIR:-/tmp}"
  mkdir -p "$outdir"
  outfile="${outdir}/flowforge-${stamp}.sql.enc"
fi

if [[ -n "${DATABASE_URL:-}" ]]; then
  dump_cmd=(pg_dump --dbname="$DATABASE_URL" --no-owner --no-acl)
else
  : "${POSTGRES_USER:=flowforge}"
  : "${POSTGRES_DB:=flowforge}"
  : "${POSTGRES_HOST:?POSTGRES_HOST is required when DATABASE_URL is unset}"
  : "${POSTGRES_PORT:=5432}"
  : "${POSTGRES_PASSWORD:?POSTGRES_PASSWORD is required when DATABASE_URL is unset}"
  export PGPASSWORD="$POSTGRES_PASSWORD"
  dump_cmd=(
    pg_dump
    -h "$POSTGRES_HOST"
    -p "$POSTGRES_PORT"
    -U "$POSTGRES_USER"
    -d "$POSTGRES_DB"
    --no-owner
    --no-acl
  )
fi

umask 077
"${dump_cmd[@]}" | python3 "$BACKUP_AEAD" seal > "$outfile"

if [[ ! -s "$outfile" ]]; then
  echo "encrypted dump is empty" >&2
  rm -f "$outfile"
  exit 1
fi

# Refuse legacy OpenSSL CBC blobs (no authentication tag).
if ! backup_assert_ffb1 "$outfile"; then
  rm -f "$outfile"
  exit 1
fi

size_bytes="$(wc -c < "$outfile" | tr -d '[:space:]')"
echo "wrote encrypted dump bytes=${size_bytes} format=FFB1"

case "$outfile" in
  *.sql.enc) manifest="${outfile%.sql.enc}.manifest.enc" ;;
  *) manifest="${outfile}.manifest.enc" ;;
esac

if ! python3 "$BACKUP_MANIFEST" seal \
  --out "$manifest" \
  --chain logical \
  --seq 1 \
  --object "logical-dump:${outfile}"; then
  rm -f "$outfile" "$manifest"
  exit 1
fi
if ! python3 "$BACKUP_MANIFEST" verify --manifest "$manifest" --dir "$(dirname "$outfile")"; then
  rm -f "$outfile" "$manifest"
  exit 1
fi
if ! backup_assert_ffb1 "$manifest"; then
  rm -f "$outfile" "$manifest"
  exit 1
fi
echo "wrote integrity manifest format=FFB1"

# Durable landing. Object keys are never tenant/workspace artifact refs —
# backups are instance-level ciphertext, not CREDENTIAL_KEK envelopes.
# Do not reuse ARTIFACT_S3_PREFIX (rejected by the API). Fixed key prefix only.
backup_s3_upload "$outfile" "$(basename "$outfile")"
backup_s3_upload "$manifest" "$(basename "$manifest")"
