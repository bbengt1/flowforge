#!/usr/bin/env bash
# Retired. Do not call this script.
#
# It used to write an unsigned SLSA-shaped JSON file from the local image
# id. That file was not a cosign signature, not an in-toto attestation, and
# not attached to a registry digest. CI treats a successful exit as a bug.
#
# Signed provenance is actions/attest-build-provenance in
# .github/workflows/supply-chain.yml (job publish-images, push to main).
# Operator verification: deploy/supply-chain/policy.md.
set -euo pipefail

echo "write-provenance.sh is retired and does not emit provenance" >&2
exit 1
