#!/usr/bin/env bash
# Proves the secret scan sees a leak that exists only in a merge commit's
# conflict resolution (#619). The key is generated at runtime and the repo is
# deleted afterwards, so nothing secret-shaped is ever committed.
set -euo pipefail

gitleaks="${GITLEAKS_BIN:-gitleaks}"
# The option the secret-scan workflow passes (its job env MERGE_DIFF_OPTS).
# Locally: MERGE_DIFF_OPTS=--diff-merges=first-parent bash scripts/check-merge-diff-scan.sh
merge_opts="${MERGE_DIFF_OPTS:-}"
if [ -z "$merge_opts" ]; then
  echo "check-merge-diff-scan: MERGE_DIFF_OPTS is not set" >&2
  exit 1
fi
if ! command -v "$gitleaks" >/dev/null 2>&1; then
  echo "check-merge-diff-scan: gitleaks not found" >&2
  exit 1
fi

tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT
repo="$tmp/repo"
mkdir "$repo"
cd "$repo"
git init -q -b main .
git config user.email "scan-check@example.invalid"
git config user.name "scan-check"
git config commit.gpgsign false

printf 'name: demo\nmode: base\n' > app.conf
git add app.conf
git commit -qm "base"

git switch -qc feature
printf 'name: demo\nmode: feature\n' > app.conf
git commit -qam "feature edit"

git switch -q main
printf 'name: demo\nmode: mainline\n' > app.conf
git commit -qam "main edit"

git switch -q feature
git merge -q main >/dev/null 2>&1 || true
token="ghp_$(head -c 512 /dev/urandom | tr -dc 'A-Za-z0-9' | head -c 36)"
printf 'name: demo\nmode: resolved\ngithub_token: %s\n' "$token" > app.conf
unset token
git add app.conf
git commit -qm "merge main into feature"

merge="$(git rev-parse feature)"
report="$tmp/report.json"

scan() { # <log-opts>
  "$gitleaks" git --no-banner --redact --exit-code 1 \
    --report-format json --report-path "$report" \
    --log-opts "$1" . >/dev/null 2>&1
}

status=0; scan "feature --not main" || status=$?
if [ "$status" -ne 0 ]; then
  echo "check-merge-diff-scan: plain range scan should miss the merge-only secret" >&2
  exit 1
fi

status=0; scan "$merge_opts feature --not main" || status=$?
if [ "$status" -eq 0 ]; then
  echo "check-merge-diff-scan: merge-diff scan did not find the merge-only secret" >&2
  exit 1
fi
python3 - "$report" "$merge" <<'PY'
import json
import sys

report, merge = sys.argv[1], sys.argv[2]
rows = json.load(open(report))
if len(rows) != 1 or rows[0].get("Commit") != merge:
    raise SystemExit(
        f"check-merge-diff-scan: expected exactly one finding on {merge}, got "
        f"{[(r.get('Commit'), r.get('File')) for r in rows]}"
    )
PY

# Weekly all-branches shape: still exactly one finding, on the merge.
status=0; scan "$merge_opts --full-history --all --diff-filter=tuxdb" || status=$?
if [ "$status" -eq 0 ]; then
  echo "check-merge-diff-scan: all-branches merge-diff scan did not find the secret" >&2
  exit 1
fi
python3 - "$report" "$merge" <<'PY'
import json
import sys

rows = json.load(open(sys.argv[1]))
if [r.get("Commit") for r in rows] != [sys.argv[2]]:
    raise SystemExit("check-merge-diff-scan: all-branches scan expected one finding on the merge")
PY

# A range with no merges must still scan cleanly with the flag.
status=0; scan "$merge_opts main" || status=$?
if [ "$status" -ne 0 ]; then
  echo "check-merge-diff-scan: merge-free range failed with the flag" >&2
  exit 1
fi

echo "check-merge-diff-scan: merge-only secret missed without the flag and found on the merge commit with it."
