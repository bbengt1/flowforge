#!/usr/bin/env bash
# E12.2 operational resilience and capacity suite.
# Relates to #183 / Part of #181. Keep #183 open.
#
# Requires TEST_DATABASE_URL (Postgres). Fails closed if a domain is skipped.
#
# Usage:
#   TEST_DATABASE_URL=… bash scripts/e12-resilience-suite.sh
#   E12_LOAD_MODE=full TEST_DATABASE_URL=… bash scripts/e12-resilience-suite.sh
#   bash scripts/e12-resilience-suite.sh --list
#
# Evidence: docs/reference/e12-resilience-capacity.md
# Last-run: docs/reference/e12-resilience-evidence/last-run.json
# Full encrypted compose restore sibling: scripts/backup/restore-rehearsal.sh
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
export E12_WRITE_EVIDENCE="${E12_WRITE_EVIDENCE:-1}"
exec python3 "$ROOT/scripts/e12-resilience-suite.py" --write-evidence "$@"
