#!/usr/bin/env bash
# Seal one Postgres WAL segment (or timeline history file) as FFB1 and
# record it in an AEAD integrity manifest. Postgres archive_command:
#   archive_command = '/usr/local/bin/archive-wal %p %f'
#
# Ciphertext is the only archive object. The plaintext segment is left
# in place for the caller (Postgres deletes %p after exit 0; receive-wal
# deletes its spool copy). Never prints the passphrase, DSN, or WAL bytes.
#
#   export BACKUP_ENCRYPTION_KEY=...
#   export BACKUP_WAL_DIR=/secure/wal
#   export BACKUP_S3_BUCKET=...          # optional; required when BACKUP_REQUIRE_S3=1
#   archive-wal /path/to/segment 000000010000000000000001
set -euo pipefail

source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/common.sh"
backup_resolve_tools

: "${BACKUP_ENCRYPTION_KEY:?BACKUP_ENCRYPTION_KEY is required}"
: "${BACKUP_WAL_DIR:?BACKUP_WAL_DIR is required}"

if [[ "$#" -ne 2 ]]; then
  echo "usage: archive-wal WAL_PATH WAL_FILENAME" >&2
  exit 2
fi

src="$1"
name="$2"
backup_validate_wal_name "$name"
if [[ ! -s "$src" ]]; then
  echo "WAL segment is missing" >&2
  exit 1
fi

case "$name" in
  *.history) role="wal-history" ;;
  *) role="wal" ;;
esac
out_name="$(backup_wal_object_name "$name")"
out_name="${out_name%$'\n'}"

mkdir -p "$BACKUP_WAL_DIR"
chmod 700 "$BACKUP_WAL_DIR"
dest_enc="${BACKUP_WAL_DIR}/${out_name}"
dest_manifest="${BACKUP_WAL_DIR}/${name}.manifest.enc"
state="${BACKUP_WAL_DIR}/chain-state.json"
lock="${BACKUP_WAL_DIR}/chain.lock"

exec 9>>"$lock"
flock 9

if [[ -f "$dest_enc" || -f "$dest_manifest" ]]; then
  if [[ ! -f "$dest_enc" || ! -f "$dest_manifest" ]]; then
    echo "WAL archive is incomplete" >&2
    exit 1
  fi
  python3 "$BACKUP_MANIFEST" verify --manifest "$dest_manifest" --dir "$BACKUP_WAL_DIR"
  backup_s3_upload "$dest_enc" "wal/${out_name}"
  backup_s3_upload "$dest_manifest" "wal/${name}.manifest.enc"
  backup_s3_upload "$dest_manifest" "wal/chain-tip.manifest.enc"
  python3 "$BACKUP_MANIFEST" state-write --state "$state" --manifest "$dest_manifest" --chain wal
  echo "wal segment already sealed name=${out_name} format=FFB1"
  exit 0
fi

stage="$(mktemp -d "${BACKUP_WAL_DIR}/.stage.XXXXXX")"
cleanup_stage() {
  rm -rf "$stage"
}
trap cleanup_stage EXIT

umask 077
sealed="${stage}/${out_name}"
python3 "$BACKUP_AEAD" seal <"$src" >"$sealed"
backup_assert_ffb1 "$sealed"

chain_line="$(python3 "$BACKUP_MANIFEST" state-read --state "$state" --chain wal)"
seq="${chain_line%%$'\t'*}"
prev="${chain_line#*$'\t'}"
if [[ ! "$seq" =~ ^[0-9]+$ ]]; then
  echo "wal chain state is invalid" >&2
  exit 1
fi

manifest="${stage}/${name}.manifest.enc"
python3 "$BACKUP_MANIFEST" seal \
  --out "$manifest" \
  --chain wal \
  --seq "$seq" \
  --prev-sha256 "$prev" \
  --object "${role}:${sealed}"
python3 "$BACKUP_MANIFEST" verify --manifest "$manifest" --dir "$stage"
backup_assert_ffb1 "$manifest"

mv "$sealed" "$dest_enc"
if ! mv "$manifest" "$dest_manifest"; then
  rm -f "$dest_enc"
  echo "WAL archive is incomplete" >&2
  exit 1
fi
chmod 600 "$dest_enc" "$dest_manifest"

# Upload before chain state advances. A retry finds the pair on disk,
# verifies it, and uploads again without minting a new sequence number.
backup_s3_upload "$dest_enc" "wal/${out_name}"
backup_s3_upload "$dest_manifest" "wal/${name}.manifest.enc"
backup_s3_upload "$dest_manifest" "wal/chain-tip.manifest.enc"
python3 "$BACKUP_MANIFEST" state-write --state "$state" --manifest "$dest_manifest" --chain wal

echo "sealed wal segment name=${out_name} seq=${seq} format=FFB1"
