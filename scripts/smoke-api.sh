#!/usr/bin/env bash
# Thin E1.1 smoke: assert control-plane health/readiness over HTTP.
# Assumes the compose `api` service is listening (default http://127.0.0.1:8080).
# Does not print environment values (DATABASE_URL / POSTGRES_PASSWORD).
set -euo pipefail

BASE_URL="${SMOKE_BASE_URL:-http://127.0.0.1:8080}"
WAIT_SECONDS="${SMOKE_WAIT_SECONDS:-120}"
BODY="$(mktemp)"
HEADERS="$(mktemp)"
trap 'rm -f "$BODY" "$HEADERS"' EXIT

request() {
  local url="$1"
  # Body and status only — never dump request env or compose config.
  # Hide curl's connection-refused noise while the API is still booting.
  curl -s -m 5 -D "$HEADERS" -o "$BODY" -w '%{http_code}' "$url" 2>/dev/null || true
}

wait_for() {
  local path="$1"
  local want_code="$2"
  local jq_expr="$3"
  local deadline=$((SECONDS + WAIT_SECONDS))
  local code=""
  while (( SECONDS < deadline )); do
    code="$(request "${BASE_URL}${path}")"
    if [[ "$code" == "$want_code" ]] && jq -e "$jq_expr" "$BODY" >/dev/null 2>&1; then
      echo "ok GET ${path} ${code} $(jq -c . "$BODY")"
      return 0
    fi
    sleep 2
  done
  echo "timeout waiting for GET ${path} == ${want_code} (${jq_expr})" >&2
  echo "last status=${code:-none} body=$(cat "$BODY" 2>/dev/null || true)" >&2
  return 1
}

assert_now() {
  local path="$1"
  local want_code="$2"
  local jq_expr="$3"
  local code
  code="$(request "${BASE_URL}${path}")"
  if [[ "$code" != "$want_code" ]] || ! jq -e "$jq_expr" "$BODY" >/dev/null 2>&1; then
    echo "assert failed GET ${path}: status=${code} want=${want_code} body=$(cat "$BODY")" >&2
    return 1
  fi
  echo "ok GET ${path} ${code} $(jq -c . "$BODY")"
}

assert_body() {
  local path="$1"
  local want_code="$2"
  local needle="$3"
  local code
  code="$(request "${BASE_URL}${path}")"
  if [[ "$code" != "$want_code" ]] || ! grep -q "$needle" "$BODY"; then
    echo "assert failed GET ${path}: status=${code} want=${want_code} needle=${needle} body=$(cat "$BODY")" >&2
    return 1
  fi
  echo "ok GET ${path} ${code}"
}

echo "smoke against ${BASE_URL}"
wait_for /api/v1/health 200 '.status == "ok"'
wait_for /api/v1/readiness 200 '.status == "ready"'

assert_body /api/v1/openapi.yaml 200 'openapi:'
assert_now /api/v1/openapi.json 200 '.openapi != null'
assert_body /api/v1/metrics 200 'flowforge_http_requests_total'

code="$(request "${BASE_URL}/api/v1/missing")"
if [[ "$code" != "404" ]] || ! jq -e '.code == "not-found" and .status == 404 and .request_id != null' "$BODY" >/dev/null 2>&1; then
  echo "assert failed GET /api/v1/missing: status=${code} body=$(cat "$BODY")" >&2
  exit 1
fi
if ! grep -qi '^content-type:[[:space:]]*application/problem+json' "$HEADERS"; then
  echo "404 missing application/problem+json content-type" >&2
  cat "$HEADERS" >&2
  exit 1
fi
if ! grep -qi '^x-request-id:' "$HEADERS"; then
  echo "404 missing X-Request-ID" >&2
  cat "$HEADERS" >&2
  exit 1
fi
echo "ok GET /api/v1/missing ${code} $(jq -c . "$BODY")"

if [[ "${SMOKE_CHECK_DB_DOWN:-}" == "1" ]]; then
  echo "stopping postgres to assert readiness failure (health must stay up)"
  docker compose stop postgres >/dev/null
  wait_for /api/v1/readiness 503 '.code == "dependency-unavailable" and .status == 503'
  if ! grep -qi '^content-type:[[:space:]]*application/problem+json' "$HEADERS"; then
    echo "readiness 503 missing application/problem+json content-type" >&2
    cat "$HEADERS" >&2
    exit 1
  fi
  assert_now /api/v1/health 200 '.status == "ok"'
fi

echo "smoke passed"
