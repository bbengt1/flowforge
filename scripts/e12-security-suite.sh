#!/usr/bin/env bash
# E12.1 security verification suite.
# Relates to #182 / Part of #181. Keep #182 open.
#
# Usage:
#   bash scripts/e12-security-suite.sh                 # run + write evidence
#   bash scripts/e12-security-suite.sh --list          # catalog only
#   bash scripts/e12-security-suite.sh --skip-web      # Go + provenance
#   TEST_DATABASE_URL=... bash scripts/e12-security-suite.sh   # include Postgres paths
#
# Evidence: docs/reference/e12-security-verification.md
# Last-run: docs/reference/e12-security-evidence/last-run.json
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
export E12_WRITE_EVIDENCE="${E12_WRITE_EVIDENCE:-1}"
exec python3 "$ROOT/scripts/e12-security-suite.py" --write-evidence "$@"
