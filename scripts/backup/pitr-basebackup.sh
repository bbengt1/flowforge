#!/usr/bin/env bash
# Physical base backup for Postgres PITR, sealed as FFB1.
# pg_basebackup -Ft --wal-method=stream writes base.tar and pg_wal.tar.
# Both are sealed before they are uploaded. Plaintext tar is not kept.
#
# The backup role needs REPLICATION. This does not start executions.
#
#   export DATABASE_URL=postgres://...
#   export BACKUP_ENCRYPTION_KEY=...
#   export BACKUP_S3_BUCKET=...     # optional; required when BACKUP_REQUIRE_S3=1
#   pitr-basebackup
set -euo pipefail

source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/common.sh"
backup_resolve_tools

: "${BACKUP_ENCRYPTION_KEY:?BACKUP_ENCRYPTION_KEY is required}"
: "${DATABASE_URL:?DATABASE_URL is required}"
: "${BACKUP_OUTDIR:=/backups}"
: "${BACKUP_PITR_CHECKPOINT:=fast}"

if [[ "$BACKUP_PITR_CHECKPOINT" != "fast" && "$BACKUP_PITR_CHECKPOINT" != "spread" ]]; then
  echo "BACKUP_PITR_CHECKPOINT is invalid" >&2
  exit 1
fi
if ! command -v pg_basebackup >/dev/null 2>&1; then
  echo "pg_basebackup is required" >&2
  exit 1
fi

mkdir -p "$BACKUP_OUTDIR"
chmod 700 "$BACKUP_OUTDIR"
umask 077

work="$(mktemp -d)"
cleanup() {
  rm -rf "$work"
}
trap cleanup EXIT

err="$(mktemp)"
set +e
pg_basebackup \
  -d "$DATABASE_URL" \
  -D "$work" \
  -Ft \
  --wal-method=stream \
  --checkpoint="$BACKUP_PITR_CHECKPOINT" \
  --no-password \
  >"$err" 2>&1
status=$?
set -e
if [[ "$status" -ne 0 ]]; then
  backup_filter_err "$err"
  rm -f "$err"
  echo "pitr base backup failed" >&2
  exit 1
fi
rm -f "$err"

shopt -s nullglob
for tar_path in "$work"/*.tar; do
  base="$(basename "$tar_path")"
  case "$base" in
    base.tar|pg_wal.tar) ;;
    *)
      echo "unexpected base backup member" >&2
      exit 1
      ;;
  esac
done
if [[ ! -s "$work/base.tar" || ! -s "$work/pg_wal.tar" ]]; then
  echo "pitr base backup is incomplete" >&2
  exit 1
fi

stamp="$(date -u +%Y%m%dT%H%M%SZ)"
base_enc="${BACKUP_OUTDIR}/base-${stamp}.tar.enc"
wal_enc="${BACKUP_OUTDIR}/pgwal-${stamp}.tar.enc"
manifest="${BACKUP_OUTDIR}/base-${stamp}.manifest.enc"

python3 "$BACKUP_AEAD" seal <"$work/base.tar" >"$base_enc"
python3 "$BACKUP_AEAD" seal <"$work/pg_wal.tar" >"$wal_enc"
rm -f "$work/base.tar" "$work/pg_wal.tar"
backup_assert_ffb1 "$base_enc"
backup_assert_ffb1 "$wal_enc"

python3 "$BACKUP_MANIFEST" seal \
  --out "$manifest" \
  --chain pitr \
  --seq 1 \
  --object "pitr-base:${base_enc}" \
  --object "pitr-wal-bundle:${wal_enc}"
python3 "$BACKUP_MANIFEST" verify --manifest "$manifest" --dir "$BACKUP_OUTDIR"
backup_assert_ffb1 "$manifest"

backup_s3_upload "$base_enc" "pitr/$(basename "$base_enc")"
backup_s3_upload "$wal_enc" "pitr/$(basename "$wal_enc")"
backup_s3_upload "$manifest" "pitr/$(basename "$manifest")"

base_bytes="$(wc -c <"$base_enc" | tr -d '[:space:]')"
echo "wrote pitr base bytes=${base_bytes} format=FFB1"
