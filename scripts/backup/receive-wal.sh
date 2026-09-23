#!/usr/bin/env bash
# Stream Postgres WAL with pg_receivewal, seal each completed segment
# (scripts/backup/archive-wal.sh), and fail closed if the stream stops.
#
# RPO is BACKUP_WAL_RPO_SECONDS (default 300): the receiver calls
# pg_switch_wal on that interval so a quiet primary still ships a segment.
# The backup role needs REPLICATION and EXECUTE on pg_switch_wal().
# Plaintext WAL stays in the spool until seal succeeds, then it is removed.
# Object storage receives FFB1 ciphertext only.
#
#   export DATABASE_URL=postgres://...
#   export BACKUP_ENCRYPTION_KEY=...
#   export BACKUP_WAL_DIR=/backups/wal
#   export BACKUP_WAL_SPOOL=/backups/spool
#   receive-wal            # run until the pod is stopped
#   receive-wal --once     # seal one switched segment, then exit
set -euo pipefail

source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/common.sh"
backup_resolve_tools

: "${BACKUP_ENCRYPTION_KEY:?BACKUP_ENCRYPTION_KEY is required}"
: "${DATABASE_URL:?DATABASE_URL is required}"
: "${BACKUP_WAL_DIR:?BACKUP_WAL_DIR is required}"
: "${BACKUP_WAL_SPOOL:=${BACKUP_WAL_DIR}.spool}"
: "${BACKUP_WAL_SLOT:=flowforge_wal}"
: "${BACKUP_WAL_RPO_SECONDS:=300}"
: "${BACKUP_WAL_POLL_SECONDS:=5}"
: "${BACKUP_WAL_RECEIVE_TIMEOUT:=90}"

mode="follow"
if [[ "${1:-}" == "--once" ]]; then
  mode="once"
elif [[ $# -gt 0 ]]; then
  echo "usage: receive-wal [--once]" >&2
  exit 2
fi

if [[ ! "$BACKUP_WAL_SLOT" =~ ^[a-z][a-z0-9_]{0,62}$ ]]; then
  echo "BACKUP_WAL_SLOT is invalid" >&2
  exit 1
fi
if [[ ! "$BACKUP_WAL_RPO_SECONDS" =~ ^[0-9]+$ || "$BACKUP_WAL_RPO_SECONDS" -lt 1 ]]; then
  echo "BACKUP_WAL_RPO_SECONDS is invalid" >&2
  exit 1
fi
if [[ ! "$BACKUP_WAL_POLL_SECONDS" =~ ^[0-9]+$ || "$BACKUP_WAL_POLL_SECONDS" -lt 1 ]]; then
  echo "BACKUP_WAL_POLL_SECONDS is invalid" >&2
  exit 1
fi
if [[ "$BACKUP_WAL_POLL_SECONDS" -ge "$BACKUP_WAL_RPO_SECONDS" && "$mode" == "follow" ]]; then
  echo "BACKUP_WAL_POLL_SECONDS must be lower than BACKUP_WAL_RPO_SECONDS" >&2
  exit 1
fi

if ! command -v pg_receivewal >/dev/null 2>&1 || ! command -v psql >/dev/null 2>&1; then
  echo "pg_receivewal and psql are required" >&2
  exit 1
fi

mkdir -p "$BACKUP_WAL_DIR" "$BACKUP_WAL_SPOOL"
chmod 700 "$BACKUP_WAL_DIR" "$BACKUP_WAL_SPOOL"
umask 077

recv_pid=""
stop_receiver() {
  if [[ -n "$recv_pid" ]] && kill -0 "$recv_pid" 2>/dev/null; then
    kill "$recv_pid" 2>/dev/null || true
    wait "$recv_pid" 2>/dev/null || true
  fi
  recv_pid=""
}

backup_psql() {
  local err out status
  err="$(mktemp)"
  out="$(mktemp)"
  set +e
  psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -q -tA "$@" >"$out" 2>"$err"
  status=$?
  set -e
  if [[ "$status" -ne 0 ]]; then
    backup_filter_err "$err"
    rm -f "$err" "$out"
    return 1
  fi
  rm -f "$err"
  cat "$out"
  rm -f "$out"
}

ensure_slot() {
  local found
  found="$(backup_psql -c "SELECT 1 FROM pg_replication_slots WHERE slot_name = '${BACKUP_WAL_SLOT}'")"
  found="${found//$'\n'/}"
  if [[ "$found" == "1" ]]; then
    return 0
  fi
  backup_psql -c "SELECT slot_name FROM pg_create_physical_replication_slot('${BACKUP_WAL_SLOT}')" >/dev/null
}

resume_chain() {
  local tip="${BACKUP_WAL_DIR}/chain-tip.manifest.enc" status
  if [[ -n "${BACKUP_S3_BUCKET:-}" && ! -f "${BACKUP_WAL_DIR}/chain-state.json" ]]; then
    set +e
    backup_s3_download "wal/chain-tip.manifest.enc" "$tip"
    status=$?
    set -e
    if [[ "$status" -eq 1 ]]; then
      exit 1
    fi
    if [[ "$status" -eq 2 ]]; then
      rm -f "$tip"
    fi
  fi
  if [[ -f "$tip" ]]; then
    python3 "$BACKUP_MANIFEST" state-resume \
      --state "${BACKUP_WAL_DIR}/chain-state.json" \
      --tip "$tip" \
      --chain wal
  elif [[ -f "${BACKUP_WAL_DIR}/chain-state.json" ]]; then
    python3 "$BACKUP_MANIFEST" state-resume \
      --state "${BACKUP_WAL_DIR}/chain-state.json" \
      --chain wal
  fi
}

start_receiver() {
  local err
  err="${BACKUP_WAL_SPOOL}/receive.err"
  : >"$err"
  pg_receivewal -d "$DATABASE_URL" -D "$BACKUP_WAL_SPOOL" -S "$BACKUP_WAL_SLOT" --synchronous \
    >>"$err" 2>&1 &
  recv_pid=$!
  local i active
  for i in $(seq 1 30); do
    if ! kill -0 "$recv_pid" 2>/dev/null; then
      backup_filter_err "$err"
      echo "wal receiver stopped" >&2
      exit 1
    fi
    active="$(backup_psql -c "SELECT active FROM pg_replication_slots WHERE slot_name = '${BACKUP_WAL_SLOT}'" || true)"
    active="${active//$'\n'/}"
    if [[ "$active" == "t" ]]; then
      return 0
    fi
    sleep 1
  done
  stop_receiver
  echo "wal receiver did not become active" >&2
  exit 1
}

archive_ready() {
  local f base out_name
  shopt -s nullglob
  for f in "$BACKUP_WAL_SPOOL"/*; do
    base="$(basename "$f")"
    case "$base" in
      *.partial|receive.err|receive.log) continue ;;
    esac
    if ! backup_validate_wal_name "$base"; then
      echo "unexpected spool file" >&2
      return 1
    fi
    out_name="$(backup_wal_object_name "$base")"
    out_name="${out_name%$'\n'}"
    if [[ -f "${BACKUP_WAL_DIR}/${out_name}" ]]; then
      rm -f "$f"
      continue
    fi
    "$(dirname "${BASH_SOURCE[0]}")/archive-wal.sh" "$f" "$base"
    rm -f "$f"
  done
}

switch_wal() {
  backup_psql -c "SELECT pg_switch_wal()" >/dev/null
}

count_sealed() {
  local n=0 f
  shopt -s nullglob
  for f in "$BACKUP_WAL_DIR"/*.wal.enc "$BACKUP_WAL_DIR"/*.history.enc; do
    [[ -f "$f" ]] || continue
    n=$((n + 1))
  done
  printf '%s\n' "$n"
}

on_signal() {
  stop_receiver
  exit 0
}

ensure_slot
resume_chain

if [[ "$mode" == "once" ]]; then
  before="$(count_sealed)"
  start_receiver
  switch_wal
  deadline=$((SECONDS + BACKUP_WAL_RECEIVE_TIMEOUT))
  while (( SECONDS < deadline )); do
    archive_ready
    now="$(count_sealed)"
    if [[ "$now" -gt "$before" ]]; then
      stop_receiver
      python3 "$BACKUP_MANIFEST" verify-chain --dir "$BACKUP_WAL_DIR" --chain wal
      echo "ok wal archive once segments=${now} rpo_seconds=${BACKUP_WAL_RPO_SECONDS} format=FFB1"
      exit 0
    fi
    sleep 1
  done
  stop_receiver
  echo "no WAL segment sealed" >&2
  exit 1
fi

trap on_signal TERM INT
start_receiver
last_switch="$(date +%s)"
while kill -0 "$recv_pid" 2>/dev/null; do
  archive_ready
  now="$(date +%s)"
  if (( now - last_switch >= BACKUP_WAL_RPO_SECONDS )); then
    switch_wal
    last_switch="$now"
  fi
  sleep "$BACKUP_WAL_POLL_SECONDS"
done
echo "wal receiver stopped" >&2
exit 1
