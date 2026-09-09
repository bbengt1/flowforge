#!/usr/bin/env bash
# Assert deployment manifests encode E1.3 safety defaults.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
fail=0

need() {
  local file="$1"
  local pattern="$2"
  if ! grep -Eq "$pattern" "$file"; then
    echo "missing /$pattern/ in ${file#"$ROOT/"}" >&2
    fail=1
  fi
}

forbid() {
  local file="$1"
  local pattern="$2"
  if grep -Eq "$pattern" "$file"; then
    echo "forbidden /$pattern/ in ${file#"$ROOT/"}" >&2
    fail=1
  fi
}

api_df="$ROOT/apps/api/Dockerfile"
need "$api_df" '^USER 65532:65532'
need "$api_df" '^FROM golang:1.26-alpine AS build$'
need "$api_df" '^FROM alpine:3.20$'

web_df="$ROOT/apps/web/Dockerfile"
need "$web_df" '^USER 65532:65532'

compose="$ROOT/docker-compose.yml"
need "$compose" 'user: "65532:65532"'
need "$compose" 'read_only: true'
need "$compose" 'no-new-privileges:true'
need "$compose" '[[:space:]]+- ALL'
need "$compose" 'mem_limit: 512m'

deploy="$ROOT/deploy/k8s/api-deployment.yaml"
need "$deploy" 'runAsUser: 65532'
need "$deploy" 'runAsGroup: 65532'
need "$deploy" 'runAsNonRoot: true'
need "$deploy" 'readOnlyRootFilesystem: true'
need "$deploy" 'allowPrivilegeEscalation: false'
need "$deploy" '[[:space:]]+- ALL'
need "$deploy" 'seccompProfile:'
need "$deploy" 'limits:'
forbid "$deploy" 'image:.*:latest([[:space:]]|$)'

need "$ROOT/deploy/k8s/default-deny-networkpolicy.yaml" 'policyTypes:'
need "$ROOT/deploy/k8s/api-networkpolicy.yaml" 'port: 8080'
need "$ROOT/deploy/k8s/api-networkpolicy.yaml" 'port: 5432'
need "$ROOT/deploy/k8s/ingress.yaml" '^  tls:'
need "$ROOT/deploy/k8s/api-configmap.yaml" 'REQUIRE_TLS: "true"'

if [[ "$fail" -eq 0 ]]; then
  echo "deploy defaults ok"
fi
exit "$fail"
