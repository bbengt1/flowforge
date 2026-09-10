#!/usr/bin/env bash
# ADV-013: two-origin Portal → embed integration harness.
# Relates to #144 / Part of #130. Keep #144 open.
#
# Usage:
#   bash scripts/adv013-cross-origin.sh              # start local stack + prove
#   bash scripts/adv013-cross-origin.sh --attach     # stack already up
#   bash scripts/adv013-cross-origin.sh --checklist  # contract tests only
#
# Documented local HTTPS origins (Portal ≠ embed):
#   https://portal.test:8443
#   https://embed.test:8444
#   https://evil.test:8445   (hostile ancestor)
#
# Add to /etc/hosts (or use Chrome --host-resolver-rules):
#   127.0.0.1 portal.test embed.test evil.test

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
EVIDENCE_DIR="${ADV013_EVIDENCE_DIR:-$ROOT/docs/reference/adv-013-evidence}"
TLS_DIR="${ADV013_TLS_DIR:-$ROOT/deploy/adv013/tls}"
RUN_DIR="${ADV013_RUN_DIR:-$ROOT/.adv013-run}"
PORTAL_ORIGIN="${ADV013_PORTAL_ORIGIN:-https://portal.test:8443}"
EMBED_ORIGIN="${ADV013_EMBED_ORIGIN:-https://embed.test:8444}"
EVIL_ORIGIN="${ADV013_EVIL_ORIGIN:-https://evil.test:8445}"
API_URL="${ADV013_API_URL:-http://127.0.0.1:8080}"
WEB_URL="${ADV013_WEB_URL:-http://127.0.0.1:3000}"
ATTACH=0
CHECKLIST_ONLY=0
KEEP=0

while [[ $# -gt 0 ]]; do
  case "$1" in
    --attach) ATTACH=1 ;;
    --checklist) CHECKLIST_ONLY=1 ;;
    --keep) KEEP=1 ;;
    *) echo "unknown arg: $1" >&2; exit 2 ;;
  esac
  shift
done

PORTAL_HOST="${PORTAL_ORIGIN#https://}"
PORTAL_HOST="${PORTAL_HOST#http://}"
EMBED_HOST="${EMBED_ORIGIN#https://}"
EMBED_HOST="${EMBED_HOST#http://}"
EVIL_HOST="${EVIL_ORIGIN#https://}"
EVIL_HOST="${EVIL_HOST#http://}"

RESOLVE=(
  --resolve "${PORTAL_HOST}:127.0.0.1"
  --resolve "${EMBED_HOST}:127.0.0.1"
  --resolve "${EVIL_HOST}:127.0.0.1"
)

log() { printf '%s\n' "$*"; }
fail() { printf 'FAIL: %s\n' "$*" >&2; exit 1; }

mkdir -p "$EVIDENCE_DIR" "$TLS_DIR" "$RUN_DIR"
PIDS_FILE="$RUN_DIR/pids"
: >"$PIDS_FILE"

cleanup() {
  if [[ "$KEEP" -eq 1 || "$ATTACH" -eq 1 ]]; then
    return
  fi
  if [[ -f "$PIDS_FILE" ]]; then
    while read -r pid; do
      [[ -n "${pid:-}" ]] || continue
      kill -- -"$pid" 2>/dev/null || kill "$pid" 2>/dev/null || true
    done <"$PIDS_FILE"
  fi
  # go run / next leave child servers; free harness ports.
  fuser -k 8080/tcp 3000/tcp 8443/tcp 8444/tcp 8445/tcp >/dev/null 2>&1 || true
}
trap cleanup EXIT

track_pid() {
  echo "$1" >>"$PIDS_FILE"
}

run_checklist() {
  log "== ADV-013 contract checklist (CI) =="
  if [[ ! -d "$ROOT/apps/web/node_modules" ]]; then
    (cd "$ROOT" && pnpm install --filter @flowforge/web...)
  fi
  (cd "$ROOT" && pnpm --filter @flowforge/web test)
}

gen_certs() {
  if [[ -f "$TLS_DIR/harness.pem" && -f "$TLS_DIR/harness-key.pem" ]]; then
    return
  fi
  log "== generating local HTTPS certs =="
  openssl req -x509 -newkey rsa:2048 -sha256 -days 3 -nodes \
    -keyout "$TLS_DIR/harness-key.pem" \
    -out "$TLS_DIR/harness.pem" \
    -subj "/CN=flowforge-adv013" \
    -addext "subjectAltName=DNS:portal.test,DNS:embed.test,DNS:evil.test,DNS:localhost,IP:127.0.0.1" \
    >/dev/null 2>&1
}

curl_https() {
  curl -sk --max-time 30 "${RESOLVE[@]}" "$@"
}

header_line() {
  # usage: header_line FILE Header-Name
  python3 - "$1" "$2" <<'PY'
import sys
path, name = sys.argv[1], sys.argv[2].lower()
text = open(path, "r", errors="replace").read()
for line in text.splitlines():
    if ":" not in line:
        continue
    key, val = line.split(":", 1)
    if key.lower() == name:
        print(val.strip())
        break
PY
}

wait_http() {
  local url="$1"
  local extra=("${@:2}")
  for _ in $(seq 1 90); do
    local code
    code="$(curl -sk --max-time 2 -o /dev/null -w '%{http_code}' "${extra[@]}" "$url" || true)"
    if [[ "$code" == "200" ]]; then
      return 0
    fi
    sleep 1
  done
  return 1
}

ensure_hosts() {
  if python3 - <<PY
import socket
for name in ("portal.test", "embed.test", "evil.test"):
    try:
        socket.getaddrinfo(name, None)
    except OSError:
        raise SystemExit(1)
raise SystemExit(0)
PY
  then
    return
  fi
  if [[ -w /etc/hosts ]]; then
    printf '\n127.0.0.1 portal.test embed.test evil.test\n' >> /etc/hosts
  elif command -v sudo >/dev/null 2>&1; then
    echo "127.0.0.1 portal.test embed.test evil.test" | sudo tee -a /etc/hosts >/dev/null || true
  fi
}

start_postgres() {
  if pg_isready -h 127.0.0.1 -p 5432 >/dev/null 2>&1; then
    return
  fi
  if command -v docker >/dev/null 2>&1 && [[ -f "$ROOT/.env" || -n "${POSTGRES_PASSWORD:-}" ]]; then
    (cd "$ROOT" && docker compose up -d postgres)
    return
  fi
  if command -v pg_isready >/dev/null 2>&1; then
    sudo service postgresql start || sudo pg_ctlcluster "$(ls /etc/postgresql | tail -1)" main start || true
  fi
}

start_local_stack() {
  export POSTGRES_PASSWORD="${POSTGRES_PASSWORD:-adv013local}"
  export POSTGRES_USER="${POSTGRES_USER:-flowforge}"
  export POSTGRES_DB="${POSTGRES_DB:-flowforge}"
  export DATABASE_URL="${DATABASE_URL:-postgres://${POSTGRES_USER}:${POSTGRES_PASSWORD}@127.0.0.1:5432/${POSTGRES_DB}?sslmode=disable}"
  export APP_ENV=development
  export TRUSTED_DEV_IDENTITY_HEADERS=1
  export PLATFORM_ADMINS="${PLATFORM_ADMINS:-https://idp.example|admin-1}"
  export EMBED_SIGNING_KEY="${EMBED_SIGNING_KEY:-$(cat "$ROOT/deploy/local/embed-signing.pem")}"
  export EMBED_SIGNING_KEY_ID="${EMBED_SIGNING_KEY_ID:-local:adv013}"
  export EMBED_ISSUER="${EMBED_ISSUER:-https://idp.example}"
  export PORTAL_ISSUER="${PORTAL_ISSUER:-https://portal.cp-ops.example}"
  export WEB_PORTAL_FRAME_ANCESTORS="$PORTAL_ORIGIN"
  export PORTAL_FRAME_ANCESTORS="$PORTAL_ORIGIN"
  export WEB_EMBED_FRAME_ANCESTORS="${WEB_EMBED_FRAME_ANCESTORS:-}"
  export CORS_ALLOWED_ORIGINS="${CORS_ALLOWED_ORIGINS:-${EMBED_ORIGIN},${PORTAL_ORIGIN},http://localhost:3000}"
  export HTTP_ADDR="${HTTP_ADDR:-:8080}"
  export NEXT_PUBLIC_API_URL="$API_URL"
  export API_INTERNAL_URL="$API_URL"

  if ! pg_isready -h 127.0.0.1 -p 5432 >/dev/null 2>&1; then
    fail "PostgreSQL is not running on 127.0.0.1:5432. Start it or use compose."
  fi

  if command -v sudo >/dev/null 2>&1; then
    sudo -u postgres psql -v ON_ERROR_STOP=1 <<SQL >/dev/null
DO \$\$
BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = '${POSTGRES_USER}') THEN
    CREATE ROLE ${POSTGRES_USER} LOGIN PASSWORD '${POSTGRES_PASSWORD}';
  END IF;
END
\$\$;
ALTER ROLE ${POSTGRES_USER} PASSWORD '${POSTGRES_PASSWORD}';
-- Isolation migration creates/alters role flowforge_app. Local
-- harness login must match compose (superuser) for that step.
ALTER ROLE ${POSTGRES_USER} SUPERUSER;
SQL
    sudo -u postgres psql -tAc "SELECT 1 FROM pg_database WHERE datname='${POSTGRES_DB}'" | grep -q 1 \
      || sudo -u postgres createdb -O "$POSTGRES_USER" "$POSTGRES_DB"
  fi
  PGPASSWORD="$POSTGRES_PASSWORD" psql -h 127.0.0.1 -U "$POSTGRES_USER" -d "$POSTGRES_DB" -c 'select 1' >/dev/null

  log "== starting API =="
  (
    cd "$ROOT/apps/api"
    env DATABASE_URL="$DATABASE_URL" \
      APP_ENV="$APP_ENV" \
      TRUSTED_DEV_IDENTITY_HEADERS="$TRUSTED_DEV_IDENTITY_HEADERS" \
      PLATFORM_ADMINS="$PLATFORM_ADMINS" \
      EMBED_SIGNING_KEY="$EMBED_SIGNING_KEY" \
      EMBED_SIGNING_KEY_ID="$EMBED_SIGNING_KEY_ID" \
      EMBED_ISSUER="$EMBED_ISSUER" \
      PORTAL_ISSUER="$PORTAL_ISSUER" \
      WEB_PORTAL_FRAME_ANCESTORS="$WEB_PORTAL_FRAME_ANCESTORS" \
      PORTAL_FRAME_ANCESTORS="$PORTAL_FRAME_ANCESTORS" \
      CORS_ALLOWED_ORIGINS="$CORS_ALLOWED_ORIGINS" \
      HTTP_ADDR="$HTTP_ADDR" \
      go run ./cmd/api
  ) >"$RUN_DIR/api.log" 2>&1 &
  track_pid $!

  wait_http "$API_URL/api/v1/health" || fail "API did not become healthy"
  wait_http "$API_URL/api/v1/readiness" || fail "API did not become ready"

  if [[ ! -d "$ROOT/apps/web/node_modules" ]]; then
    (cd "$ROOT" && pnpm install --filter @flowforge/web...)
  fi

  log "== starting Next.js web =="
  (
    cd "$ROOT/apps/web"
    env WEB_PORTAL_FRAME_ANCESTORS="$WEB_PORTAL_FRAME_ANCESTORS" \
      PORTAL_FRAME_ANCESTORS="$PORTAL_FRAME_ANCESTORS" \
      NEXT_PUBLIC_API_URL="$NEXT_PUBLIC_API_URL" \
      API_INTERNAL_URL="$API_INTERNAL_URL" \
      pnpm exec next dev --hostname 127.0.0.1 --port 3000
  ) >"$RUN_DIR/web.log" 2>&1 &
  track_pid $!

  wait_http "$WEB_URL/" || fail "web did not become ready"

  log "== starting ADV-013 origin terminator =="
  env ADV013_PORTAL_ORIGIN="$PORTAL_ORIGIN" \
    ADV013_EMBED_ORIGIN="$EMBED_ORIGIN" \
    ADV013_EVIL_ORIGIN="$EVIL_ORIGIN" \
    ADV013_API_URL="$API_URL" \
    ADV013_WEB_URL="$WEB_URL" \
    ADV013_TLS_CERT="$TLS_DIR/harness.pem" \
    ADV013_TLS_KEY="$TLS_DIR/harness-key.pem" \
    PORTAL_ISSUER="$PORTAL_ISSUER" \
    node "$ROOT/deploy/adv013/portal-host/server.mjs" \
    >"$RUN_DIR/portal-host.log" 2>&1 &
  track_pid $!

  wait_http "$PORTAL_ORIGIN/health" "${RESOLVE[@]}" || fail "portal origin did not become ready"
  wait_http "$EMBED_ORIGIN/embed/v1/workflows" "${RESOLVE[@]}" || fail "embed origin did not become ready"
}

prove() {
  local stamp
  stamp="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  local raw="$RUN_DIR/prove"
  mkdir -p "$raw"

  log "== distinct origins =="
  [[ "$PORTAL_ORIGIN" != "$EMBED_ORIGIN" ]] || fail "portal origin must differ from embed origin"
  curl_https -D "$raw/portal-health.hdr" -o "$raw/portal-health.body" "$PORTAL_ORIGIN/health"
  curl_https -D "$raw/embed-home.hdr" -o "$raw/embed-home.body" "$EMBED_ORIGIN/embed/v1/workflows"
  curl_https -D "$raw/standalone.hdr" -o "$raw/standalone.body" "$EMBED_ORIGIN/workflows"
  curl_https -D "$raw/leaked.hdr" -o /dev/null "$EMBED_ORIGIN/embed/v1/workflows?assertion=eyJhbGciOiJFZERTQSJ9.e30.sig"
  curl_https -D "$raw/catalog.hdr" -o "$raw/catalog.body" "$API_URL/api/v1/portal/adapter"
  curl_https -D "$raw/embed-catalog.hdr" -o "$raw/embed-catalog.body" "$API_URL/api/v1/embed/catalog"

  local embed_csp standalone_csp rejected catalog_fa
  embed_csp="$(header_line "$raw/embed-home.hdr" content-security-policy || true)"
  standalone_csp="$(header_line "$raw/standalone.hdr" content-security-policy || true)"
  rejected="$(header_line "$raw/leaked.hdr" x-flowforge-embed-rejected || true)"
  catalog_fa="$(python3 - "$raw/catalog.body" <<'PY'
import json,sys
doc=json.load(open(sys.argv[1]))
print(" ".join(doc.get("frameAncestors") or []))
PY
)"

  log "embed CSP: $embed_csp"
  log "standalone CSP: $standalone_csp"
  log "catalog frameAncestors: $catalog_fa"

  echo "$embed_csp" | grep -q "frame-ancestors" || fail "embed CSP missing frame-ancestors"
  echo "$embed_csp" | grep -F -q "$PORTAL_ORIGIN" || fail "embed CSP must allowlist portal origin"
  echo "$embed_csp" | grep -F -q "$EVIL_ORIGIN" && fail "embed CSP must not include hostile origin"
  echo "$standalone_csp" | grep -q "frame-ancestors 'none'" || fail "standalone must stay frame-ancestors none"
  echo "$catalog_fa" | grep -F -q "$PORTAL_ORIGIN" || fail "catalog frameAncestors must publish portal origin"
  [[ "$rejected" == "1" ]] || fail "assertion in URL must set x-flowforge-embed-rejected"

  log "== bootstrap + mint + body-only exchange =="
  curl_https -D "$raw/bootstrap.hdr" -o "$raw/bootstrap.body" -X POST "$PORTAL_ORIGIN/api/bootstrap"
  python3 - "$raw/bootstrap.body" <<'PY'
import json,sys
doc=json.load(open(sys.argv[1]))
if not doc.get("tenantId"):
    raise SystemExit(f"bootstrap missing tenantId: {doc}")
PY
  curl_https -D "$raw/mint.hdr" -o "$raw/mint.body" -X POST "$PORTAL_ORIGIN/api/mint"
  python3 - "$raw/mint.body" "$raw/exchange.json" <<'PY'
import json,sys
doc=json.load(open(sys.argv[1]))
assertion=doc.get("assertion") or ""
if doc.get("ok") is False or not assertion or assertion.count(".") != 2:
    raise SystemExit(f"mint failed: { {k:doc.get(k) for k in doc if k!='assertion'} }")
open(sys.argv[2],"w").write(json.dumps({"assertion":assertion,"sdk":"embed.v1"}))
print(f"mint tokenId={doc.get('tokenId')} issuer={doc.get('issuer')} subject={doc.get('subject')}")
PY

  curl_https -D "$raw/exchange.hdr" -o "$raw/exchange.body" \
    -H "content-type: application/json" \
    --data-binary @"$raw/exchange.json" \
    "$EMBED_ORIGIN/api/v1/embed/exchange"

  local set_cookie
  set_cookie="$(python3 - "$raw/exchange.hdr" <<'PY'
import sys
text=open(sys.argv[1], errors="replace").read().splitlines()
vals=[]
for line in text:
    if line.lower().startswith("set-cookie:"):
        vals.append(line.split(":",1)[1].strip())
print("\n".join(vals))
PY
)"
  printf '%s\n' "$set_cookie" >"$raw/set-cookie.txt"
  echo "$set_cookie" | grep -qi 'samesite=none' || fail "exchange Set-Cookie must be SameSite=None"
  echo "$set_cookie" | grep -qi 'partitioned' || fail "exchange Set-Cookie must be Partitioned"
  echo "$set_cookie" | grep -qi 'secure' || fail "exchange Set-Cookie must keep Secure"
  echo "$set_cookie" | grep -Eiq 'samesite=lax|samesite=strict' && fail "embed cookies must not use Lax/Strict"
  echo "$set_cookie" | grep -qi 'ff_session' || fail "exchange must set ff_session"

  local cookie_hdr
  cookie_hdr="$(python3 - "$raw/set-cookie.txt" <<'PY'
import sys
cookies=[]
for line in open(sys.argv[1]):
    part=line.split(";",1)[0].strip()
    if "=" in part:
        cookies.append(part)
print("; ".join(cookies))
PY
)"
  curl_https -D "$raw/session.hdr" -o "$raw/session.body" \
    -H "Cookie: $cookie_hdr" \
    "$EMBED_ORIGIN/api/v1/session"
  python3 - "$raw/session.body" "$raw/session.hdr" <<'PY'
import sys
hdr=open(sys.argv[2], errors="replace").read().splitlines()
status=next((l.split()[1] for l in hdr if l.startswith("HTTP/")), "?")
body=open(sys.argv[1], errors="replace").read()
if status not in {"200","201"}:
    raise SystemExit(f"session after CHIPS cookie expected 200, got {status} {body[:300]}")
print(f"session status={status}")
PY

  log "== empty allowlist (real contract module) =="
  (
    cd "$ROOT/apps/web"
    node --experimental-strip-types --input-type=module <<'NODE'
import assert from "node:assert/strict";
import {
  adv013EmptyAllowlistFailsClosed,
  adv013HostileAncestorBlocked,
} from "./src/lib/adv013-cross-origin-contract.ts";
assert.equal(adv013EmptyAllowlistFailsClosed(), true);
assert.equal(adv013HostileAncestorBlocked(), true);
console.log("empty allowlist fail-closed: ok");
console.log("hostile ancestor blocked (contract): ok");
NODE
  ) | tee "$raw/empty-allowlist.txt"

  # Redacted evidence (never the JWS).
  python3 - "$EVIDENCE_DIR/last-run.json" "$stamp" "$PORTAL_ORIGIN" "$EMBED_ORIGIN" "$EVIL_ORIGIN" \
    "$embed_csp" "$standalone_csp" "$catalog_fa" "$rejected" "$raw/set-cookie.txt" "$raw/mint.body" "$raw/session.hdr" <<'PY'
import json,sys,re
out, stamp, portal, embed, evil, embed_csp, standalone_csp, catalog_fa, rejected, cookie_path, mint_path, session_hdr = sys.argv[1:]
cookies=open(cookie_path, errors="replace").read()
mint=json.load(open(mint_path))
session_status=next((l.split()[1] for l in open(session_hdr, errors="replace") if l.startswith("HTTP/")), "?")
def redact_cookie(text):
    return re.sub(r'(ff_session|ff_csrf)=[^;]+', r'\1=<redacted>', text, flags=re.I)
doc={
  "id": "ADV-013",
  "relatesTo": 144,
  "partOf": 130,
  "keepIssueOpen": True,
  "ranAt": stamp,
  "origins": {"portal": portal, "embed": embed, "evil": evil, "distinct": portal != embed},
  "checks": {
    "distinctHttpsOrigins": portal != embed and portal.startswith("https://") and embed.startswith("https://"),
    "frameAncestorsAllowlistsPortal": portal in embed_csp,
    "hostileAncestorAbsentFromCsp": evil not in embed_csp,
    "standaloneFrameAncestorsNone": "frame-ancestors 'none'" in standalone_csp,
    "catalogPublishesPortal": portal in catalog_fa,
    "assertionInUrlRejected": rejected == "1",
    "mintViaAdapter": bool(mint.get("tokenId")),
    "chipsSameSiteNone": "samesite=none" in cookies.lower(),
    "chipsPartitioned": "partitioned" in cookies.lower(),
    "chipsSecure": "secure" in cookies.lower(),
    "sessionWithChipsCookie": session_status in {"200","201"},
    "emptyAllowlistFailClosed": True,
  },
  "embedCsp": embed_csp,
  "standaloneCsp": standalone_csp,
  "catalogFrameAncestors": catalog_fa.split(),
  "setCookieRedacted": redact_cookie(cookies).strip().splitlines(),
  "mint": {k: mint.get(k) for k in ("tokenId","issuer","subject","audience","ok") if k in mint},
}
open(out,"w").write(json.dumps(doc, indent=2) + "\n")
print(json.dumps(doc["checks"], indent=2))
if not all(doc["checks"].values()):
    raise SystemExit("one or more ADV-013 checks failed")
PY

  if command -v google-chrome >/dev/null 2>&1; then
    log "== browser screenshots =="
    local profile="$RUN_DIR/chrome-profile"
    mkdir -p "$profile"
    local chrome_args=(
      --headless=new
      --disable-gpu
      --no-sandbox
      --disable-dev-shm-usage
      --ignore-certificate-errors
      --allow-insecure-localhost
      --user-data-dir="$profile"
      --host-resolver-rules="MAP portal.test 127.0.0.1, MAP embed.test 127.0.0.1, MAP evil.test 127.0.0.1"
      --window-size=1280,900
    )
    timeout 20 google-chrome "${chrome_args[@]}" \
      --screenshot="$EVIDENCE_DIR/portal-host.png" \
      "${PORTAL_ORIGIN}/" >/dev/null 2>&1 || true
    timeout 25 google-chrome "${chrome_args[@]}" \
      --virtual-time-budget=15000 \
      --screenshot="$EVIDENCE_DIR/portal-host-mounted.png" \
      "${PORTAL_ORIGIN}/?autorun=1" >/dev/null 2>&1 || true
    timeout 20 google-chrome "${chrome_args[@]}" \
      --screenshot="$EVIDENCE_DIR/hostile-ancestor.png" \
      "$EVIL_ORIGIN/" >/dev/null 2>&1 || true
  fi

  python3 - "$EVIDENCE_DIR/RUN.md" "$EVIDENCE_DIR/last-run.json" <<'PY'
import json,sys
doc=json.load(open(sys.argv[2]))
checks="\n".join(f"- {'PASS' if v else 'FAIL'} `{k}`" for k,v in doc["checks"].items())
open(sys.argv[1],"w").write(f"""# ADV-013 last run

Relates to #144 / Part of #130. **Keep #144 open.**

Ran at `{doc["ranAt"]}` (UTC).

## Origins

| Role | Origin |
| --- | --- |
| Portal host | `{doc["origins"]["portal"]}` |
| Embed / FlowForge | `{doc["origins"]["embed"]}` |
| Hostile ancestor | `{doc["origins"]["evil"]}` |

Distinct: `{doc["origins"]["distinct"]}`.

## Checks

{checks}

## CSP / catalog

Embed `/embed/v1`:

```
{doc["embedCsp"]}
```

Standalone:

```
{doc["standaloneCsp"]}
```

`GET /portal/adapter` `frameAncestors`: `{doc["catalogFrameAncestors"]}`

## CHIPS Set-Cookie (values redacted)

```
{chr(10).join(doc["setCookieRedacted"])}
```

Mint metadata (no JWS): `{doc["mint"]}`

Re-run: `bash scripts/adv013-cross-origin.sh` (see `docs/reference/portal-adapter.md`).
""")
print("wrote", sys.argv[1])
PY

  log "evidence written to $EVIDENCE_DIR"
}

if [[ "$CHECKLIST_ONLY" -eq 1 ]]; then
  run_checklist
  exit 0
fi

if [[ "${ADV013_SKIP_UNIT:-0}" != "1" ]]; then
  run_checklist
fi
gen_certs
ensure_hosts
if [[ "$ATTACH" -eq 0 ]]; then
  start_postgres || true
  start_local_stack
fi
prove
log "ADV-013 harness finished"
