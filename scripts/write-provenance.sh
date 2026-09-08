#!/usr/bin/env bash
# Record a thin SLSA-style provenance statement for a locally built image.
# Does not print registry credentials.
set -euo pipefail

IMAGE="${1:?image tag required}"
OUT="${2:?output path required}"

digest="$(docker image inspect --format '{{index .RepoDigests 0}}' "$IMAGE" 2>/dev/null || true)"
id="$(docker image inspect --format '{{.Id}}' "$IMAGE")"
# Local load often has no repo digest; fall back to the image id.
subject_digest="${digest##*:}"
if [[ -z "$digest" || "$digest" == "<no value>" ]]; then
  subject_digest="${id#sha256:}"
fi

mkdir -p "$(dirname "$OUT")"
cat > "$OUT" <<EOF
{
  "predicateType": "https://slsa.dev/provenance/v1",
  "subject": [
    {
      "name": "${IMAGE}",
      "digest": { "sha256": "${subject_digest}" }
    }
  ],
  "predicate": {
    "buildDefinition": {
      "buildType": "https://github.com/bbengt1/flowforge/deploy/supply-chain",
      "externalParameters": {
        "source": "${GITHUB_SERVER_URL:-https://github.com}/${GITHUB_REPOSITORY:-bbengt1/flowforge}",
        "revision": "${GITHUB_SHA:-unknown}",
        "dockerfile": "apps/api/Dockerfile",
        "workflow": "${GITHUB_WORKFLOW:-local}"
      }
    },
    "runDetails": {
      "builder": { "id": "${GITHUB_WORKFLOW_REF:-local}" }
    }
  }
}
EOF

echo "wrote provenance $OUT"
