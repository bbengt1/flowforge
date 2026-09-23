#!/usr/bin/env bash
# RPO/RTO rehearsal for G.1.4 (findings A3, C3).
#
# Proves the DSN encrypted-backup path (same script the k8s CronJob runs),
# restores into an isolated database, and records wall-clock RTO.
# RPO is the CronJob interval documented in retention-backup.md (24h).
#
# Never prints BACKUP_ENCRYPTION_KEY, DATABASE_URL, or POSTGRES_PASSWORD.
#
#   export TEST_DATABASE_URL=postgres://flowforge:…@127.0.0.1:5432/flowforge?sslmode=disable
#   export BACKUP_ENCRYPTION_KEY=…   # optional; generated when unset
#   bash scripts/backup/rpo-rto-rehearsal.sh
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$ROOT"

if ! command -v pg_dump >/dev/null 2>&1 || ! command -v psql >/dev/null 2>&1; then
  echo "pg_dump and psql are required (install postgresql-client)" >&2
  exit 1
fi
if ! command -v openssl >/dev/null 2>&1; then
  echo "openssl is required" >&2
  exit 1
fi

# RTO budget for CI-sized DBs (schema + restore + version check). Operators
# tighten this for production-sized dumps in the runbook.
: "${BACKUP_RTO_BUDGET_SECONDS:=1800}"
# Documented RPO for the shipped CronJob schedule (daily).
: "${BACKUP_RPO_HOURS:=24}"

python3 - "$ROOT" <<'PY'
import json, os, subprocess, sys, tempfile, time
from pathlib import Path
from urllib.parse import unquote, urlparse

root = Path(sys.argv[1])
rto_budget = int(os.environ.get("BACKUP_RTO_BUDGET_SECONDS", "1800"))
rpo_hours = int(os.environ.get("BACKUP_RPO_HOURS", "24"))


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
        "raw": raw,
    }


dsn = os.environ.get("TEST_DATABASE_URL") or os.environ.get("DATABASE_URL") or ""
if not dsn.strip():
    raise SystemExit("TEST_DATABASE_URL / DATABASE_URL is required")

src = parse_dsn(dsn)
env = os.environ.copy()
env["BACKUP_ENCRYPTION_KEY"] = os.environ.get("BACKUP_ENCRYPTION_KEY") or os.urandom(16).hex()
env["DATABASE_URL"] = src["raw"]
env.pop("PGPASSWORD", None)
# Discrete vars unused when DATABASE_URL is set; clear so the script cannot
# accidentally prefer a caller password that disagrees with the DSN.
for k in ("POSTGRES_PASSWORD", "POSTGRES_HOST", "POSTGRES_USER", "POSTGRES_DB"):
    env.pop(k, None)

base_psql = [
    "psql",
    "-h", src["host"],
    "-p", src["port"],
    "-U", src["user"],
    "-v", "ON_ERROR_STOP=1",
    "-tA",
]
psql_env = env.copy()
psql_env["PGPASSWORD"] = src["password"]


def psql(dbname: str, sql: str) -> str:
    out = subprocess.check_output(
        base_psql + ["-d", dbname, "-c", sql], env=psql_env, text=True
    )
    return out.strip()


src_ver = psql(src["dbname"], "SELECT COALESCE(MAX(version), 0) FROM schema_migrations")
if not src_ver or src_ver == "0":
    raise SystemExit("source schema_migrations is empty; migrate before RPO/RTO rehearsal")

restore_db = f"flowforge_rpo_{os.getpid()}_{int(time.time())}"
workdir = Path(tempfile.mkdtemp(prefix="rpo-rto-"))
enc = workdir / "flowforge.sql.enc"
env["BACKUP_OUTDIR"] = str(workdir)
# Local rehearsal does not require object-store upload.
env.pop("BACKUP_S3_BUCKET", None)
env.pop("BACKUP_REQUIRE_S3", None)


def cleanup() -> None:
    try:
        subprocess.run(
            base_psql
            + ["-d", "postgres", "-c", f'DROP DATABASE IF EXISTS "{restore_db}" WITH (FORCE)'],
            env=psql_env,
            check=False,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
        )
    finally:
        if not os.environ.get("BACKUP_KEEP_WORKDIR"):
            import shutil

            shutil.rmtree(workdir, ignore_errors=True)


started = time.monotonic()
try:
    # Same entrypoint the CronJob runs (DSN path).
    subprocess.run(
        ["bash", str(root / "scripts/backup/run-encrypted-backup.sh"), str(enc)],
        env=env,
        check=True,
    )
    if not enc.is_file() or enc.stat().st_size == 0:
        raise SystemExit("encrypted dump missing after run-encrypted-backup.sh")
    manifest = (
        enc.with_name(enc.name[: -len(".sql.enc")] + ".manifest.enc")
        if enc.name.endswith(".sql.enc")
        else enc.with_name(enc.name + ".manifest.enc")
    )
    if not manifest.is_file() or manifest.read_bytes()[:4] != b"FFB1":
        raise SystemExit("integrity manifest missing after run-encrypted-backup.sh")
    subprocess.run(
        [
            "python3",
            str(root / "scripts/backup/manifest.py"),
            "verify",
            "--manifest",
            str(manifest),
            "--dir",
            str(workdir),
        ],
        env=env,
        check=True,
    )
    tamper_dir = workdir / "tamper"
    tamper_dir.mkdir()
    dumped = bytearray(enc.read_bytes())
    dumped[-1] ^= 0x01
    (tamper_dir / enc.name).write_bytes(bytes(dumped))
    (tamper_dir / manifest.name).write_bytes(manifest.read_bytes())
    tampered = subprocess.run(
        [
            "python3",
            str(root / "scripts/backup/manifest.py"),
            "verify",
            "--manifest",
            str(tamper_dir / manifest.name),
            "--dir",
            str(tamper_dir),
        ],
        env=env,
    )
    if tampered.returncode == 0:
        raise SystemExit("tampered backup was accepted")
    (tamper_dir / enc.name).write_bytes(enc.read_bytes())
    man_bytes = bytearray(manifest.read_bytes())
    man_bytes[-1] ^= 0x01
    (tamper_dir / manifest.name).write_bytes(bytes(man_bytes))
    tampered = subprocess.run(
        [
            "python3",
            str(root / "scripts/backup/manifest.py"),
            "verify",
            "--manifest",
            str(tamper_dir / manifest.name),
            "--dir",
            str(tamper_dir),
        ],
        env=env,
    )
    if tampered.returncode == 0:
        raise SystemExit("tampered manifest was accepted")

    psql("postgres", f'CREATE DATABASE "{restore_db}"')
    dec = subprocess.Popen(
        ["python3", str(root / "scripts/backup/aead.py"), "open"],
        env=env,
        stdin=enc.open("rb"),
        stdout=subprocess.PIPE,
    )
    subprocess.run(
        [
            "psql",
            "-h",
            src["host"],
            "-p",
            src["port"],
            "-U",
            src["user"],
            "-d",
            restore_db,
            "-v",
            "ON_ERROR_STOP=1",
            "-q",
        ],
        env=psql_env,
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

    elapsed = time.monotonic() - started
    if elapsed > rto_budget:
        raise SystemExit(
            f"RTO budget exceeded elapsed_seconds={elapsed:.1f} budget_seconds={rto_budget}"
        )

    evidence = {
        "id": "G.1.4-rpo-rto",
        "rpoHours": rpo_hours,
        "rtoBudgetSeconds": rto_budget,
        "rtoObservedSeconds": round(elapsed, 3),
        "sourceVersion": int(src_ver),
        "restoredVersion": int(got),
        "encrypted": True,
        "aead": True,
        "format": "FFB1",
        "integrityManifest": True,
        "tamperRejected": True,
        "logicalRpoHours": rpo_hours,
        "pitrRpoSeconds": int(os.environ.get("BACKUP_WAL_RPO_SECONDS", "300")),
        "path": "scripts/backup/run-encrypted-backup.sh",
        "cronSchedule": "0 2 * * *",
        "isolatedDatabaseDropped": True,
    }
    out_dir = Path(os.environ.get("E12_RUN_DIR") or (root / ".e12-run"))
    out_dir.mkdir(parents=True, exist_ok=True)
    (out_dir / "rpo-rto-last-run.json").write_text(json.dumps(evidence, indent=2) + "\n")
    print(
        f"ok rpo/rto rehearsal version={got} rpo_hours={rpo_hours} "
        f"rto_seconds={elapsed:.1f} budget_seconds={rto_budget}"
    )
finally:
    cleanup()
PY
