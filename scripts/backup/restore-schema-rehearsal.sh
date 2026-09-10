#!/usr/bin/env bash
# E12.2 isolated dump → restore against TEST_DATABASE_URL (no compose API).
# Sibling of restore-rehearsal.sh (encrypted compose dump + hardened API boot).
# Relates to #183 / Part of #181. Keep #183 open.
#
# Never prints BACKUP_ENCRYPTION_KEY, DATABASE_URL, or POSTGRES_PASSWORD.
#
#   export TEST_DATABASE_URL=postgres://flowforge:…@127.0.0.1:5432/flowforge?sslmode=disable
#   export BACKUP_ENCRYPTION_KEY=…   # optional; generated when unset
#   bash scripts/backup/restore-schema-rehearsal.sh
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$ROOT"

if ! command -v pg_dump >/dev/null 2>&1 || ! command -v psql >/dev/null 2>&1; then
  echo "pg_dump and psql are required (install postgresql-client)" >&2
  exit 1
fi

python3 - "$ROOT" <<'PY'
import json, os, subprocess, sys, tempfile, time
from pathlib import Path
from urllib.parse import unquote, urlparse

root = Path(sys.argv[1])


def parse_dsn(raw: str) -> dict[str, str]:
    u = urlparse(raw)
    if u.scheme not in ("postgres", "postgresql"):
        raise SystemExit("TEST_DATABASE_URL / DATABASE_URL must be a postgres URL")
    db = unquote(u.path.lstrip("/").split("/")[0] or "")
    if not db:
        raise SystemExit("database name missing from DSN")
    return {
        "host": u.hostname or "127.0.0.1",
        "port": str(u.port or 5432),
        "user": unquote(u.username or "flowforge"),
        "password": unquote(u.password or ""),
        "dbname": db,
    }


dsn = os.environ.get("TEST_DATABASE_URL") or os.environ.get("DATABASE_URL") or ""
if not dsn.strip():
    raise SystemExit("TEST_DATABASE_URL / DATABASE_URL is required")

src = parse_dsn(dsn)
env = os.environ.copy()
env["PGPASSWORD"] = src["password"]
env["BACKUP_ENCRYPTION_KEY"] = os.environ.get("BACKUP_ENCRYPTION_KEY") or os.urandom(16).hex()
# Do not inherit a caller PGPASSWORD that disagrees with the DSN.
base_psql = [
    "psql",
    "-h", src["host"],
    "-p", src["port"],
    "-U", src["user"],
    "-v", "ON_ERROR_STOP=1",
    "-tA",
]


def psql(dbname: str, sql: str) -> str:
    out = subprocess.check_output(base_psql + ["-d", dbname, "-c", sql], env=env, text=True)
    return out.strip()


src_ver = psql(src["dbname"], "SELECT COALESCE(MAX(version), 0) FROM schema_migrations")
if not src_ver or src_ver == "0":
    raise SystemExit("source schema_migrations is empty; migrate before restore rehearsal")

restore_db = f"flowforge_e12r_{os.getpid()}_{int(time.time())}"
workdir = Path(tempfile.mkdtemp(prefix="e12-restore-"))
enc = workdir / "flowforge.sql.enc"

def cleanup() -> None:
    try:
        subprocess.run(
            base_psql + ["-d", "postgres", "-c", f'DROP DATABASE IF EXISTS "{restore_db}" WITH (FORCE)'],
            env=env,
            check=False,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
        )
    finally:
        if not os.environ.get("BACKUP_KEEP_WORKDIR"):
            for p in workdir.glob("*"):
                p.unlink(missing_ok=True)
            workdir.rmdir()


try:
    dump = subprocess.Popen(
        [
            "pg_dump",
            "-h", src["host"],
            "-p", src["port"],
            "-U", src["user"],
            "-d", src["dbname"],
            "--no-owner",
            "--no-acl",
        ],
        env=env,
        stdout=subprocess.PIPE,
    )
    enc_proc = subprocess.run(
        ["openssl", "enc", "-aes-256-cbc", "-pbkdf2", "-salt", "-pass", "env:BACKUP_ENCRYPTION_KEY"],
        env=env,
        stdin=dump.stdout,
        stdout=enc.open("wb"),
        check=True,
    )
    dump.stdout.close()
    if dump.wait() != 0:
        raise SystemExit("pg_dump failed")
    if enc.stat().st_size == 0:
        raise SystemExit("encrypted dump is empty")

    psql("postgres", f'CREATE DATABASE "{restore_db}"')
    dec = subprocess.Popen(
        ["openssl", "enc", "-d", "-aes-256-cbc", "-pbkdf2", "-pass", "env:BACKUP_ENCRYPTION_KEY", "-in", str(enc)],
        env=env,
        stdout=subprocess.PIPE,
    )
    restore = subprocess.run(
        ["psql", "-h", src["host"], "-p", src["port"], "-U", src["user"], "-d", restore_db, "-v", "ON_ERROR_STOP=1", "-q"],
        env=env,
        stdin=dec.stdout,
        stdout=subprocess.DEVNULL,
        check=True,
    )
    dec.stdout.close()
    if dec.wait() != 0:
        raise SystemExit("decrypt failed")

    got = psql(restore_db, "SELECT COALESCE(MAX(version), 0) FROM schema_migrations")
    if got != src_ver:
        raise SystemExit(f"restore version mismatch source={src_ver} restored={got}")
    jobs = psql(restore_db, "SELECT to_regclass('public.execution_jobs') IS NOT NULL")
    if jobs not in ("t", "true", "1"):
        raise SystemExit("restored database is missing execution_jobs")
    print(f"ok schema restore rehearsal version={got} isolated={restore_db}")
    evidence = {
        "id": "E12.2-restore-schema",
        "sourceVersion": int(src_ver),
        "restoredVersion": int(got),
        "encrypted": True,
        "isolatedDatabaseDropped": True,
    }
    out_dir = Path(os.environ.get("E12_RUN_DIR") or (root / ".e12-run"))
    out_dir.mkdir(parents=True, exist_ok=True)
    (out_dir / "restore-schema-last-run.json").write_text(json.dumps(evidence, indent=2) + "\n")
finally:
    cleanup()
PY
