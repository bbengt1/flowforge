#!/usr/bin/env bash
# Integrity-manifest and WAL/PITR rehearsal (G.2.7 / C3).
#
# Proves:
#   - logical dumps from run-encrypted-backup.sh carry an FFB1 manifest
#   - tampered dumps and tampered manifests fail closed
#   - receive-wal --once seals a real WAL segment
#   - a physical base backup plus later WAL restores a row written after
#     the base backup (PITR), and the encryption key is not stored in
#     the manifest, restore helper, or postgresql.auto.conf
#
# Refuses non-local Postgres. Never prints BACKUP_ENCRYPTION_KEY,
# DATABASE_URL, or POSTGRES_PASSWORD.
#
#   export TEST_DATABASE_URL=postgres://flowforge:…@127.0.0.1:5432/flowforge
#   bash scripts/backup/manifest-pitr-rehearsal.sh
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$ROOT"
source "$ROOT/scripts/backup/common.sh"
backup_resolve_tools
export BACKUP_AEAD BACKUP_MANIFEST

for bindir in /usr/lib/postgresql/*/bin; do
  if [[ -d "$bindir" ]]; then
    PATH="${bindir}:${PATH}"
  fi
done
export PATH

for cmd in psql pg_dump pg_basebackup pg_receivewal pg_ctl postgres python3 openssl; do
  if ! command -v "$cmd" >/dev/null 2>&1; then
    echo "${cmd} is required" >&2
    exit 1
  fi
done

: "${BACKUP_RTO_BUDGET_SECONDS:=1800}"
: "${BACKUP_WAL_RPO_SECONDS:=300}"
: "${BACKUP_PITR_PORT:=5433}"

envfile="$(mktemp)"
chmod 600 "$envfile"
python3 - "$envfile" <<'PY'
import os, shlex, sys
from urllib.parse import unquote, urlparse

raw = os.environ.get("TEST_DATABASE_URL") or os.environ.get("DATABASE_URL") or ""
if not raw.strip():
    raise SystemExit("TEST_DATABASE_URL / DATABASE_URL is required")
u = urlparse(raw)
if u.scheme not in ("postgres", "postgresql"):
    raise SystemExit("TEST_DATABASE_URL / DATABASE_URL must be a postgres URL")
host = u.hostname or ""
if host not in ("127.0.0.1", "localhost", "::1"):
    raise SystemExit("PITR rehearsal refuses non-local Postgres")
db = unquote(u.path.lstrip("/").split("/")[0] or "")
if not db:
    raise SystemExit("database name missing from DSN")
user = unquote(u.username or "flowforge")
password = unquote(u.password or "")
port = str(u.port or 5432)
lines = [
    f"PGHOST={shlex.quote(host)}",
    f"PGPORT={shlex.quote(port)}",
    f"PGUSER={shlex.quote(user)}",
    f"PGPASSWORD={shlex.quote(password)}",
    f"PGDATABASE={shlex.quote(db)}",
    f"DATABASE_URL={shlex.quote(raw)}",
]
sys.stdout = open(sys.argv[1], "w")
sys.stdout.write("\n".join(lines) + "\n")
PY
# shellcheck disable=SC1090
source "$envfile"
rm -f "$envfile"
export PGHOST PGPORT PGUSER PGPASSWORD PGDATABASE DATABASE_URL
export BACKUP_ENCRYPTION_KEY="${BACKUP_ENCRYPTION_KEY:-$(openssl rand -hex 16)}"
unset BACKUP_S3_BUCKET BACKUP_REQUIRE_S3 AWS_ACCESS_KEY_ID AWS_SECRET_ACCESS_KEY || true

if pg_isready -h 127.0.0.1 -p "$BACKUP_PITR_PORT" >/dev/null 2>&1; then
  echo "PITR port is already in use" >&2
  exit 1
fi

workdir="$(mktemp -d)"
recv_pid=""
restore_dest=""
marker_db="ffpitr$$"
BACKUP_WAL_SLOT="ffpitr$$"
export BACKUP_WAL_SLOT
nonce="$(openssl rand -hex 16)"
started="$(date +%s)"

cleanup() {
  set +e
  if [[ -n "$restore_dest" && -d "$restore_dest" ]]; then
    pg_ctl -D "$restore_dest" -m immediate -w stop >/dev/null 2>&1
  fi
  if [[ -n "$recv_pid" ]]; then
    kill "$recv_pid" 2>/dev/null
    wait "$recv_pid" 2>/dev/null
  fi
  if [[ -n "${DATABASE_URL:-}" ]]; then
    psql -h "$PGHOST" -p "$PGPORT" -U "$PGUSER" -d postgres -v ON_ERROR_STOP=1 -q -c \
      "SELECT pg_terminate_backend(active_pid) FROM pg_replication_slots WHERE slot_name = '${BACKUP_WAL_SLOT}' AND active_pid IS NOT NULL" \
      >/dev/null 2>&1
    psql -h "$PGHOST" -p "$PGPORT" -U "$PGUSER" -d postgres -q -c \
      "SELECT pg_drop_replication_slot(slot_name) FROM pg_replication_slots WHERE slot_name = '${BACKUP_WAL_SLOT}'" \
      >/dev/null 2>&1
    psql -h "$PGHOST" -p "$PGPORT" -U "$PGUSER" -d postgres -q -c \
      "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = '${marker_db}' AND pid <> pg_backend_pid()" \
      >/dev/null 2>&1
    psql -h "$PGHOST" -p "$PGPORT" -U "$PGUSER" -d postgres -q -c "DROP DATABASE IF EXISTS \"${marker_db}\"" >/dev/null 2>&1
  fi
  rm -rf "$workdir"
}
trap cleanup EXIT

assert_manifest_clean() {
  local manifest="$1"
  BACKUP_MANIFEST="$BACKUP_MANIFEST" python3 - "$manifest" <<'PY'
import importlib.util
import os
import sys
from pathlib import Path

spec = importlib.util.spec_from_file_location("flowforge_manifest", os.environ["BACKUP_MANIFEST"])
mod = importlib.util.module_from_spec(spec)
spec.loader.exec_module(mod)
plain = mod._open_bytes(Path(sys.argv[1]).read_bytes())
# Object names can contain the database name. Compare the passphrase and
# the full DSN, which must never be inventoried.
for value in (
    os.environ.get("BACKUP_ENCRYPTION_KEY", ""),
    os.environ.get("DATABASE_URL", ""),
):
    if value and value.encode() in plain:
        raise SystemExit("integrity manifest contains forbidden material")
if b"postgres://" in plain or b"postgresql://" in plain:
    raise SystemExit("integrity manifest contains forbidden material")
PY
}

reject_tamper() {
  local src_dir="$1"
  local manifest_name="$2"
  local object_name="$3"
  local tamper="$workdir/tamper-$$-$RANDOM"
  mkdir -p "$tamper"
  cp "${src_dir}/${object_name}" "${src_dir}/${manifest_name}" "$tamper/"
  python3 - "$tamper/$object_name" <<'PY'
import pathlib, sys
p = pathlib.Path(sys.argv[1])
blob = bytearray(p.read_bytes())
blob[-1] ^= 0x01
p.write_bytes(bytes(blob))
PY
  if python3 "$BACKUP_MANIFEST" verify --manifest "$tamper/$manifest_name" --dir "$tamper" >/dev/null 2>&1; then
    echo "tampered backup was accepted" >&2
    exit 1
  fi
  cp "${src_dir}/${object_name}" "$tamper/"
  python3 - "$tamper/$manifest_name" <<'PY'
import pathlib, sys
p = pathlib.Path(sys.argv[1])
blob = bytearray(p.read_bytes())
blob[-1] ^= 0x01
p.write_bytes(bytes(blob))
PY
  if python3 "$BACKUP_MANIFEST" verify --manifest "$tamper/$manifest_name" --dir "$tamper" >/dev/null 2>&1; then
    echo "tampered manifest was accepted" >&2
    exit 1
  fi
  rm -rf "$tamper"
}

logical="$workdir/logical"
mkdir -p "$logical"
bash "$ROOT/scripts/backup/run-encrypted-backup.sh" "$logical/flowforge.sql.enc"
test -s "$logical/flowforge.manifest.enc"
python3 "$BACKUP_MANIFEST" verify --manifest "$logical/flowforge.manifest.enc" --dir "$logical" --exact
assert_manifest_clean "$logical/flowforge.manifest.enc"
reject_tamper "$logical" "flowforge.manifest.enc" "flowforge.sql.enc"

export BACKUP_WAL_DIR="$workdir/wal-once"
export BACKUP_WAL_SPOOL="$workdir/wal-once-spool"
export BACKUP_WAL_RECEIVE_TIMEOUT="${BACKUP_WAL_RECEIVE_TIMEOUT:-90}"
bash "$ROOT/scripts/backup/receive-wal.sh" --once
for _ in $(seq 1 30); do
  slot_active="$(psql -h "$PGHOST" -p "$PGPORT" -U "$PGUSER" -d postgres -tA -c "SELECT active FROM pg_replication_slots WHERE slot_name = '${BACKUP_WAL_SLOT}'" 2>/dev/null || true)"
  slot_active="${slot_active//$'\n'/}"
  if [[ "$slot_active" != "t" ]]; then
    break
  fi
  sleep 1
done
if [[ "$slot_active" == "t" ]]; then
  echo "wal slot stayed active after --once" >&2
  exit 1
fi

export BACKUP_WAL_SPOOL="$workdir/spool"
mkdir -p "$BACKUP_WAL_SPOOL"
chmod 700 "$BACKUP_WAL_SPOOL"
pg_receivewal -d "$DATABASE_URL" -D "$BACKUP_WAL_SPOOL" -S "$BACKUP_WAL_SLOT" --synchronous \
  >"$workdir/receive.err" 2>&1 &
recv_pid=$!
active=""
for _ in $(seq 1 30); do
  if ! kill -0 "$recv_pid" 2>/dev/null; then
    backup_filter_err "$workdir/receive.err"
    echo "wal receiver stopped" >&2
    exit 1
  fi
  active="$(psql -h "$PGHOST" -p "$PGPORT" -U "$PGUSER" -d postgres -tA -c "SELECT active FROM pg_replication_slots WHERE slot_name = '${BACKUP_WAL_SLOT}'" 2>/dev/null || true)"
  active="${active//$'\n'/}"
  if [[ "$active" == "t" ]]; then
    break
  fi
  sleep 1
done
if [[ "$active" != "t" ]]; then
  backup_filter_err "$workdir/receive.err"
  echo "wal receiver did not become active" >&2
  exit 1
fi

export BACKUP_OUTDIR="$workdir/pitr"
mkdir -p "$BACKUP_OUTDIR"
bash "$ROOT/scripts/backup/pitr-basebackup.sh"
pitr_manifest="$(find "$BACKUP_OUTDIR" -name 'base-*.manifest.enc' -print -quit)"
if [[ -z "$pitr_manifest" ]]; then
  echo "pitr manifest missing" >&2
  exit 1
fi
python3 "$BACKUP_MANIFEST" verify --manifest "$pitr_manifest" --dir "$BACKUP_OUTDIR"
assert_manifest_clean "$pitr_manifest"

# Close the segment the base backup copied, then write the marker into a
# later segment so recovery has to fetch it from the sealed archive.
psql -h "$PGHOST" -p "$PGPORT" -U "$PGUSER" -d postgres -v ON_ERROR_STOP=1 -q -c "SELECT pg_switch_wal()" >/dev/null
psql -h "$PGHOST" -p "$PGPORT" -U "$PGUSER" -d postgres -v ON_ERROR_STOP=1 -q -c "CREATE DATABASE \"${marker_db}\""
psql -h "$PGHOST" -p "$PGPORT" -U "$PGUSER" -d "$marker_db" -v ON_ERROR_STOP=1 -q -c \
  "CREATE TABLE pitr_marker(id int primary key, nonce text not null)"
psql -h "$PGHOST" -p "$PGPORT" -U "$PGUSER" -d "$marker_db" -v ON_ERROR_STOP=1 -q -c \
  "INSERT INTO pitr_marker(id, nonce) VALUES (1, '${nonce}')"

export BACKUP_WAL_DIR="$workdir/wal"
mkdir -p "$BACKUP_WAL_DIR"
chmod 700 "$BACKUP_WAL_DIR"
seen_before=" "
shopt -s nullglob
for segment in "$BACKUP_WAL_SPOOL"/*; do
  seen_before="${seen_before}$(basename "$segment") "
done
shopt -u nullglob
psql -h "$PGHOST" -p "$PGPORT" -U "$PGUSER" -d postgres -v ON_ERROR_STOP=1 -q -c "SELECT pg_switch_wal()" >/dev/null

sealed_marker=0
for _ in $(seq 1 60); do
  shopt -s nullglob
  for segment in "$BACKUP_WAL_SPOOL"/*; do
    base="$(basename "$segment")"
    [[ "$base" == *.partial ]] && continue
    [[ "$base" == "receive.err" ]] && continue
    if [[ "$base" =~ ^[0-9A-F]{24}$ ]]; then
      bash "$ROOT/scripts/backup/archive-wal.sh" "$segment" "$base"
      rm -f "$segment"
      if [[ "$seen_before" != *" ${base} "* ]]; then
        sealed_marker=1
      fi
    fi
  done
  shopt -u nullglob
  if [[ "$sealed_marker" -eq 1 ]]; then
    break
  fi
  sleep 1
done
if [[ "$sealed_marker" -ne 1 ]]; then
  echo "marker WAL segment was not sealed" >&2
  exit 1
fi
kill "$recv_pid" 2>/dev/null || true
wait "$recv_pid" 2>/dev/null || true
recv_pid=""

python3 "$BACKUP_MANIFEST" verify-chain --dir "$BACKUP_WAL_DIR" --chain wal
wal_manifest="$(find "$BACKUP_WAL_DIR" -name '[0-9A-F]*.manifest.enc' ! -name 'chain-tip.manifest.enc' -print | sort | tail -n 1)"
wal_object="$(find "$BACKUP_WAL_DIR" -name '[0-9A-F]*.wal.enc' -print | sort | tail -n 1)"
if [[ -z "$wal_manifest" || -z "$wal_object" ]]; then
  echo "sealed WAL manifest missing" >&2
  exit 1
fi
assert_manifest_clean "$wal_manifest"
reject_tamper "$BACKUP_WAL_DIR" "$(basename "$wal_manifest")" "$(basename "$wal_object")"
python3 - "$wal_object" <<'PY'
import importlib.util, os, sys
from pathlib import Path
spec = importlib.util.spec_from_file_location("aead", os.environ["BACKUP_AEAD"])
mod = importlib.util.module_from_spec(spec)
spec.loader.exec_module(mod)
blob = Path(sys.argv[1]).read_bytes()
if blob[:4] != b"FFB1":
    raise SystemExit("WAL archive is not FFB1 AEAD")
import io
out = io.BytesIO()
mod.open_blob(io.BytesIO(blob), out)
plain = out.getvalue()
key = os.environ["BACKUP_ENCRYPTION_KEY"].encode()
if not plain or plain[:4] == b"FFB1" or key in plain:
    raise SystemExit("WAL plaintext failed closed checks")
PY

restore_dest="$workdir/restore"
bash "$ROOT/scripts/backup/pitr-restore.sh" \
  --base-manifest "$pitr_manifest" \
  --base-dir "$BACKUP_OUTDIR" \
  --wal-dir "$BACKUP_WAL_DIR" \
  --dest "$restore_dest" \
  --replay \
  --port "$BACKUP_PITR_PORT"

if grep -q -F "$BACKUP_ENCRYPTION_KEY" "$restore_dest/flowforge-restore-wal.sh" "$restore_dest/postgresql.auto.conf"; then
  echo "restore config contains the encryption key" >&2
  exit 1
fi

got=""
for _ in $(seq 1 30); do
  got="$(psql -h "$restore_dest/socket" -p "$BACKUP_PITR_PORT" -d "$marker_db" -tA -c "SELECT nonce FROM pitr_marker WHERE id = 1" 2>/dev/null || true)"
  got="${got//$'\n'/}"
  if [[ "$got" == "$nonce" ]]; then
    break
  fi
  sleep 1
done
if [[ "$got" != "$nonce" ]]; then
  echo "pitr replay did not restore the marker row" >&2
  exit 1
fi

# Archived WAL must still be ciphertext after replay.
python3 - "$wal_object" <<'PY'
import pathlib, sys
blob = pathlib.Path(sys.argv[1]).read_bytes()
if blob[:4] != b"FFB1":
    raise SystemExit("WAL archive lost FFB1 framing")
PY

elapsed="$(( $(date +%s) - started ))"
if [[ "$elapsed" -gt "$BACKUP_RTO_BUDGET_SECONDS" ]]; then
  echo "RTO budget exceeded elapsed_seconds=${elapsed} budget_seconds=${BACKUP_RTO_BUDGET_SECONDS}" >&2
  exit 1
fi

EVIDENCE_ELAPSED="$elapsed" EVIDENCE_ROOT="$ROOT" python3 - <<'PY'
import json, os
from pathlib import Path
root = Path(os.environ["EVIDENCE_ROOT"])
out_dir = Path(os.environ.get("E12_RUN_DIR") or (root / ".e12-run"))
out_dir.mkdir(parents=True, exist_ok=True)
evidence = {
    "id": "G.2.7-manifest-pitr",
    "format": "FFB1",
    "aead": "AES-256-GCM",
    "integrityManifest": True,
    "tamperRejected": True,
    "logicalRpoHours": 24,
    "pitrRpoSeconds": int(os.environ.get("BACKUP_WAL_RPO_SECONDS", "300")),
    "rtoBudgetSeconds": int(os.environ.get("BACKUP_RTO_BUDGET_SECONDS", "1800")),
    "rtoObservedSeconds": int(os.environ["EVIDENCE_ELAPSED"]),
    "walSealed": True,
    "pitrBaseSealed": True,
    "pitrReplay": True,
    "markerMatched": True,
    "plaintextSecretsInManifest": False,
}
(out_dir / "manifest-pitr-last-run.json").write_text(json.dumps(evidence, indent=2) + "\n")
PY

echo "ok manifest/pitr rehearsal rpo_seconds=${BACKUP_WAL_RPO_SECONDS} rto_seconds=${elapsed} budget_seconds=${BACKUP_RTO_BUDGET_SECONDS} format=FFB1"
