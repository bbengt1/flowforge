#!/usr/bin/env bash
# Prove state recovery: encrypted dump → isolated Postgres → schema check
# (and optional API health/readiness against the restored database).
#
# Prerequisites: compose `postgres` is up and migrated (e.g. `docker compose up -d postgres api`).
# Never prints BACKUP_ENCRYPTION_KEY, DATABASE_URL, or POSTGRES_PASSWORD.
#
#   export POSTGRES_PASSWORD=...
#   export BACKUP_ENCRYPTION_KEY=...
#   bash scripts/backup/restore-rehearsal.sh
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$ROOT"

: "${POSTGRES_USER:=flowforge}"
: "${POSTGRES_DB:=flowforge}"
: "${POSTGRES_PASSWORD:?POSTGRES_PASSWORD is required}"
: "${BACKUP_ENCRYPTION_KEY:?BACKUP_ENCRYPTION_KEY is required}"
: "${BACKUP_SOURCE_SERVICE:=postgres}"
: "${BACKUP_VERIFY_API:=1}"
: "${BACKUP_API_IMAGE:=flowforge-api:local}"

WORKDIR="${BACKUP_WORKDIR:-$(mktemp -d)}"
ENC="$WORKDIR/flowforge.sql.enc"
ISOLATED="flowforge-restore-rehearsal-$$"
RESTORE_API="flowforge-restore-api-$$"
KEEP_WORKDIR="${BACKUP_KEEP_WORKDIR:-}"

cleanup() {
  docker rm -f "$RESTORE_API" >/dev/null 2>&1 || true
  docker rm -f "$ISOLATED" >/dev/null 2>&1 || true
  if [[ -z "$KEEP_WORKDIR" ]]; then
    rm -rf "$WORKDIR"
  fi
}
trap cleanup EXIT

echo "encrypting dump from compose service ${BACKUP_SOURCE_SERVICE}"
docker compose exec -T -e PGPASSWORD="$POSTGRES_PASSWORD" "$BACKUP_SOURCE_SERVICE" \
  pg_dump -U "$POSTGRES_USER" -d "$POSTGRES_DB" --no-owner --no-acl \
  | openssl enc -aes-256-cbc -pbkdf2 -salt -pass env:BACKUP_ENCRYPTION_KEY \
  > "$ENC"

if [[ ! -s "$ENC" ]]; then
  echo "encrypted dump is empty" >&2
  exit 1
fi

echo "starting isolated postgres"
docker run -d --name "$ISOLATED" \
  -e POSTGRES_USER="$POSTGRES_USER" \
  -e POSTGRES_PASSWORD="$POSTGRES_PASSWORD" \
  -e POSTGRES_DB="$POSTGRES_DB" \
  postgres:16-alpine >/dev/null

# pg_isready only means the postmaster accepts connections. Wait until
# POSTGRES_DB exists — CREATE DATABASE races the first client otherwise.
ready=0
for _ in $(seq 1 40); do
  if docker exec -e PGPASSWORD="$POSTGRES_PASSWORD" "$ISOLATED" \
    psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -c 'SELECT 1' >/dev/null 2>&1; then
    ready=1
    break
  fi
  sleep 1
done
if [[ "$ready" -ne 1 ]]; then
  echo "isolated postgres did not become ready" >&2
  exit 1
fi

echo "decrypting and restoring"
openssl enc -d -aes-256-cbc -pbkdf2 -pass env:BACKUP_ENCRYPTION_KEY -in "$ENC" \
  | docker exec -i -e PGPASSWORD="$POSTGRES_PASSWORD" "$ISOLATED" \
    psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -v ON_ERROR_STOP=1 >/dev/null

row="$(docker exec -e PGPASSWORD="$POSTGRES_PASSWORD" "$ISOLATED" \
  psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -tA -c \
  "SELECT version FROM schema_migrations ORDER BY version LIMIT 1")"
row="$(echo "$row" | tr -d '[:space:]')"
if [[ -z "$row" ]]; then
  echo "restore rehearsal failed: schema_migrations is empty" >&2
  exit 1
fi
echo "ok restored schema_migrations version=${row}"

if [[ "$BACKUP_VERIFY_API" != "1" ]]; then
  echo "restore rehearsal passed (schema only)"
  exit 0
fi

if ! docker image inspect "$BACKUP_API_IMAGE" >/dev/null 2>&1; then
  echo "API image ${BACKUP_API_IMAGE} not present; schema check is the rehearsal evidence" >&2
  echo "restore rehearsal passed (schema only)"
  exit 0
fi

src_id="$(docker compose ps -q "$BACKUP_SOURCE_SERVICE")"
network="$(docker inspect -f '{{range $k, $v := .NetworkSettings.Networks}}{{$k}}{{end}}' "$src_id" | awk '{print $1}')"
if [[ -z "$network" ]]; then
  echo "could not resolve compose network for API verify" >&2
  exit 1
fi
docker network connect "$network" "$ISOLATED"

echo "starting API against restored database"
VERIFY_PORT="${BACKUP_VERIFY_PORT:-18080}"
docker run -d --name "$RESTORE_API" --network "$network" \
  --user 65532:65532 \
  --read-only \
  --cap-drop ALL \
  --security-opt no-new-privileges:true \
  --tmpfs /tmp:uid=65532,gid=65532,mode=1777 \
  -p "${VERIFY_PORT}:8080" \
  -e HTTP_ADDR=":8080" \
  -e "DATABASE_URL=postgres://${POSTGRES_USER}:${POSTGRES_PASSWORD}@${ISOLATED}:5432/${POSTGRES_DB}?sslmode=disable" \
  "$BACKUP_API_IMAGE" >/dev/null

api_ok=0
for _ in $(seq 1 40); do
  code="$(curl -s -m 3 -o /dev/null -w '%{http_code}' "http://127.0.0.1:${VERIFY_PORT}/api/v1/health" 2>/dev/null || true)"
  if [[ "$code" == "200" ]]; then
    ready_code="$(curl -s -m 3 -o /dev/null -w '%{http_code}' "http://127.0.0.1:${VERIFY_PORT}/api/v1/readiness" 2>/dev/null || true)"
    if [[ "$ready_code" == "200" ]]; then
      api_ok=1
      break
    fi
  fi
  sleep 2
done

if [[ "$api_ok" -ne 1 ]]; then
  echo "restore rehearsal failed: API health/readiness against restored DB" >&2
  docker logs "$RESTORE_API" >&2 || true
  exit 1
fi

echo "ok API health and readiness against restored database"
echo "restore rehearsal passed"
