#!/usr/bin/env bash
# Verify FFB1 integrity manifests, then restore a PITR base.
# Fails closed before writing a data directory if authentication or a
# checksum fails. WAL segments stay ciphertext in --wal-dir; Postgres
# restore_command decrypts a segment only when recovery asks for it.
# The encryption key is read from the environment. It is not written
# into postgresql.auto.conf or the restore helper.
#
#   export BACKUP_ENCRYPTION_KEY=...
#   pitr-restore --base-manifest DIR/base.manifest.enc --base-dir DIR \
#     --wal-dir WAL --dest /var/lib/restore
#   pitr-restore ... --replay --port 5433
set -euo pipefail

source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/common.sh"
backup_resolve_tools

: "${BACKUP_ENCRYPTION_KEY:?BACKUP_ENCRYPTION_KEY is required}"

base_manifest=""
base_dir=""
wal_dir=""
dest=""
replay=0
port="${BACKUP_PITR_PORT:-5433}"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --base-manifest) base_manifest="${2:-}"; shift 2 ;;
    --base-dir) base_dir="${2:-}"; shift 2 ;;
    --wal-dir) wal_dir="${2:-}"; shift 2 ;;
    --dest) dest="${2:-}"; shift 2 ;;
    --port) port="${2:-}"; shift 2 ;;
    --replay) replay=1; shift ;;
    *)
      echo "usage: pitr-restore --base-manifest PATH --base-dir DIR --dest DIR [--wal-dir DIR] [--replay] [--port N]" >&2
      exit 2
      ;;
  esac
done

if [[ -z "$base_manifest" || -z "$base_dir" || -z "$dest" ]]; then
  echo "usage: pitr-restore --base-manifest PATH --base-dir DIR --dest DIR [--wal-dir DIR] [--replay] [--port N]" >&2
  exit 2
fi
if [[ ! "$port" =~ ^[0-9]+$ || "$port" -lt 1 || "$port" -gt 65535 ]]; then
  echo "PITR port is invalid" >&2
  exit 1
fi
if [[ -e "$dest" && -n "$(ls -A "$dest" 2>/dev/null || true)" ]]; then
  echo "PITR dest is not empty" >&2
  exit 1
fi

python3 "$BACKUP_MANIFEST" verify --manifest "$base_manifest" --dir "$base_dir"

base_name=""
wal_bundle=""
list_out="$(python3 "$BACKUP_MANIFEST" list --manifest "$base_manifest")"
while IFS=$'\t' read -r role name; do
  [[ -z "$role" ]] && continue
  case "$role" in
    pitr-base) base_name="$name" ;;
    pitr-wal-bundle) wal_bundle="$name" ;;
  esac
done <<<"$list_out"

if [[ -z "$base_name" || -z "$wal_bundle" ]]; then
  echo "pitr manifest is missing base or wal bundle" >&2
  exit 1
fi

if [[ -n "$wal_dir" ]]; then
  if compgen -G "${wal_dir}/*.manifest.enc" >/dev/null; then
    python3 "$BACKUP_MANIFEST" verify-chain --dir "$wal_dir" --chain wal
  fi
fi

mkdir -p "$dest"
chmod 700 "$dest"
umask 077
tmp="$(mktemp -d)"
cleanup_tmp() { rm -rf "$tmp"; }
trap cleanup_tmp EXIT

python3 "$BACKUP_AEAD" open <"${base_dir}/${base_name}" >"${tmp}/base.tar"
python3 "$BACKUP_AEAD" open <"${base_dir}/${wal_bundle}" >"${tmp}/pg_wal.tar"
tar -C "$dest" -xf "${tmp}/base.tar"
mkdir -p "${dest}/pg_wal"
tar -C "${dest}/pg_wal" -xf "${tmp}/pg_wal.tar"
rm -f "${tmp}/base.tar" "${tmp}/pg_wal.tar" "${dest}/postmaster.pid" "${dest}/standby.signal"
if [[ ! -f "${dest}/backup_label" || ! -f "${dest}/PG_VERSION" ]]; then
  echo "pitr base is missing backup_label" >&2
  exit 1
fi

archive="${wal_dir:-${tmp}/empty-wal}"
if [[ -z "$wal_dir" ]]; then
  mkdir -p "$archive"
fi

python3_bin="$(command -v python3)"
helper="${dest}/flowforge-restore-wal.sh"
if [[ "$helper" == *"'"* || "$archive" == *"'"* || "$BACKUP_AEAD" == *"'"* ]]; then
  echo "restore path is invalid" >&2
  exit 1
fi
cat >"$helper" <<EOF
#!/bin/sh
set -eu
name="\$1"
out="\$2"
case "\$name" in
  *.history) src='${archive}'/"\${name}.enc" ;;
  *) src='${archive}'/"\${name}.wal.enc" ;;
esac
if [ ! -f "\$src" ]; then
  exit 1
fi
tmp="\${out}.partial"
'${python3_bin}' '${BACKUP_AEAD}' open <"\$src" >"\$tmp"
mv "\$tmp" "\$out"
EOF
chmod 700 "$helper"

if grep -q -F "$BACKUP_ENCRYPTION_KEY" "$helper"; then
  echo "restore helper contains the encryption key" >&2
  exit 1
fi

cat >>"${dest}/postgresql.auto.conf" <<EOF
restore_command = '${helper} %f %p'
recovery_target_action = 'promote'
EOF
if grep -q -F "$BACKUP_ENCRYPTION_KEY" "${dest}/postgresql.auto.conf"; then
  echo "restore config contains the encryption key" >&2
  exit 1
fi
: >"${dest}/recovery.signal"
chmod 700 "$dest"

if [[ "$replay" -ne 1 ]]; then
  echo "pitr restore prepared dest=${dest} format=FFB1"
  exit 0
fi

if ! command -v pg_ctl >/dev/null 2>&1 || ! command -v postgres >/dev/null 2>&1; then
  echo "pg_ctl and postgres are required for --replay" >&2
  exit 1
fi
if pg_isready -h 127.0.0.1 -p "$port" >/dev/null 2>&1; then
  echo "PITR port is already in use" >&2
  exit 1
fi

socket_dir="${dest}/socket"
mkdir -p "$socket_dir"
chmod 700 "$socket_dir"
log="${dest}/restore.log"
pg_ctl -D "$dest" -l "$log" -w -t 90 start \
  -o "-p ${port} -c listen_addresses=127.0.0.1 -c unix_socket_directories=${socket_dir}"

ready=0
for _ in $(seq 1 60); do
  in_recovery="$(psql -h "$socket_dir" -p "$port" -d postgres -tA -c "SELECT pg_is_in_recovery()" 2>/dev/null || true)"
  in_recovery="${in_recovery//$'\n'/}"
  if [[ "$in_recovery" == "f" ]]; then
    ready=1
    break
  fi
  if ! pg_ctl -D "$dest" status >/dev/null 2>&1; then
    break
  fi
  sleep 1
done
if [[ "$ready" -ne 1 ]]; then
  echo "pitr replay did not promote" >&2
  if [[ -f "$log" ]]; then
    backup_filter_err "$log"
  fi
  pg_ctl -D "$dest" -m fast -w stop >/dev/null 2>&1 || true
  exit 1
fi
echo "pitr replay promoted port=${port} format=FFB1"
