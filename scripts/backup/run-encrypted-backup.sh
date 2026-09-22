#!/usr/bin/env bash
# Encrypted pg_dump from a Postgres DSN (Kubernetes CronJob / CI).
# Sibling of encrypt-pg-dump.sh (compose exec). AEAD format FFB1
# (AES-256-GCM + PBKDF2) via scripts/backup/aead.py.
#
# Never prints BACKUP_ENCRYPTION_KEY, DATABASE_URL, POSTGRES_PASSWORD,
# or object-store credentials. Ciphertext is authenticated; plaintext
# secrets are not written to the backup blob (whole dump is sealed).
#
#   export DATABASE_URL='postgres://…'   # or POSTGRES_* discrete vars
#   export BACKUP_ENCRYPTION_KEY=...
#   # Optional durable landing (required by the k8s CronJob):
#   export BACKUP_S3_BUCKET=...
#   export AWS_ACCESS_KEY_ID=...
#   export AWS_SECRET_ACCESS_KEY=...
#   bash scripts/backup/run-encrypted-backup.sh [outfile]
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
AEAD="${ROOT}/scripts/backup/aead.py"
if [[ ! -f "$AEAD" ]]; then
  # CronJob image installs the helper next to the entrypoint.
  AEAD="/usr/local/lib/flowforge/aead.py"
fi
if [[ ! -f "$AEAD" ]]; then
  echo "aead.py helper missing" >&2
  exit 1
fi
if ! command -v python3 >/dev/null 2>&1; then
  echo "python3 is required for AEAD seal" >&2
  exit 1
fi

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
"${dump_cmd[@]}" | python3 "$AEAD" seal > "$outfile"

if [[ ! -s "$outfile" ]]; then
  echo "encrypted dump is empty" >&2
  rm -f "$outfile"
  exit 1
fi

# Refuse legacy OpenSSL CBC blobs (no authentication tag).
magic="$(head -c 4 "$outfile" | LC_ALL=C od -An -tx1 | tr -d ' \n')"
if [[ "$magic" != "46464231" ]]; then
  echo "backup blob is not FFB1 AEAD" >&2
  rm -f "$outfile"
  exit 1
fi

size_bytes="$(wc -c < "$outfile" | tr -d '[:space:]')"
echo "wrote encrypted dump bytes=${size_bytes} format=FFB1"

# Durable landing. Object keys are never tenant/workspace artifact refs —
# backups are instance-level ciphertext, not CREDENTIAL_KEK envelopes.
# Do not reuse ARTIFACT_S3_PREFIX (rejected by the API). Fixed key prefix only.
if [[ -n "${BACKUP_S3_BUCKET:-}" ]]; then
  if ! command -v aws >/dev/null 2>&1; then
    echo "BACKUP_S3_BUCKET is set but aws CLI is not installed" >&2
    exit 1
  fi
  : "${AWS_ACCESS_KEY_ID:?AWS_ACCESS_KEY_ID is required when BACKUP_S3_BUCKET is set}"
  : "${AWS_SECRET_ACCESS_KEY:?AWS_SECRET_ACCESS_KEY is required when BACKUP_S3_BUCKET is set}"

  prefix="${BACKUP_S3_PREFIX:-flowforge-db}"
  prefix="${prefix#/}"
  prefix="${prefix%/}"
  if [[ -z "$prefix" || "$prefix" == *..* || "$prefix" == *" "* ]]; then
    echo "BACKUP_S3_PREFIX is invalid" >&2
    exit 1
  fi
  key="${prefix}/$(basename "$outfile")"
  endpoint_args=()
  if [[ -n "${BACKUP_S3_ENDPOINT:-}" ]]; then
    endpoint_args=(--endpoint-url "$BACKUP_S3_ENDPOINT")
  fi
  region="${BACKUP_S3_REGION:-${AWS_DEFAULT_REGION:-us-east-1}}"
  if ! aws s3 cp "$outfile" "s3://${BACKUP_S3_BUCKET}/${key}" \
    --region "$region" \
    --only-show-errors \
    "${endpoint_args[@]}" >/dev/null; then
    echo "s3 upload failed" >&2
    exit 1
  fi
  echo "uploaded encrypted dump key=${key}"
elif [[ "${BACKUP_REQUIRE_S3:-}" == "1" ]]; then
  echo "BACKUP_S3_BUCKET is required when BACKUP_REQUIRE_S3=1" >&2
  exit 1
fi
