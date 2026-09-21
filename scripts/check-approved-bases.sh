#!/usr/bin/env bash
# Fail if a Dockerfile FROM line is not an approved, digest-pinned base.
# Allowlist is name:tag in deploy/supply-chain/approved-bases.txt.
# Every FROM that names a registry image must be name:tag@sha256:<64 hex>.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
ALLOW="$ROOT/deploy/supply-chain/approved-bases.txt"
# API (#10) and web (#11) images share UID 65532 and this allowlist.
DOCKERFILES=("$ROOT/apps/api/Dockerfile" "$ROOT/apps/web/Dockerfile")

if [[ ! -f "$ALLOW" ]]; then
  echo "missing $ALLOW" >&2
  exit 1
fi

approved() {
  local image="$1"
  local base="${image%%@*}"
  while IFS= read -r line || [[ -n "$line" ]]; do
    line="${line%%#*}"
    line="$(echo "$line" | tr -d '[:space:]')"
    [[ -z "$line" ]] && continue
    if [[ "$base" == "$line" ]]; then
      return 0
    fi
  done < "$ALLOW"
  return 1
}

digest_pinned() {
  local image="$1"
  local digest="${image#*@}"
  [[ "$image" == *@sha256:* ]] || return 1
  [[ "$digest" =~ ^sha256:[0-9a-f]{64}$ ]]
}

failed=0
for file in "${DOCKERFILES[@]}"; do
  while IFS= read -r raw; do
    rest="${raw#FROM }"
    rest="${rest#from }"
    # Drop optional --platform=...
    if [[ "$rest" == --platform=* ]]; then
      rest="${rest#* }"
    fi
    image="${rest%% *}"
    # Multi-stage named references have no registry/tag (FROM deps AS build).
    if [[ "$image" != *:* ]]; then
      continue
    fi
    if ! digest_pinned "$image"; then
      echo "unpinned base in ${file#"$ROOT/"}: $image (require name:tag@sha256:<64 hex>)" >&2
      failed=1
      continue
    fi
    if ! approved "$image"; then
      echo "unapproved base in ${file#"$ROOT/"}: $image" >&2
      failed=1
    else
      echo "ok base ${file#"$ROOT/"}: $image"
    fi
  done < <(grep -E '^[[:space:]]*FROM[[:space:]]+' "$file" | sed 's/^[[:space:]]*//')
done

exit "$failed"
