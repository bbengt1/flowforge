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
need "$api_df" '^FROM golang:1\.26-alpine@sha256:[0-9a-f]{64} AS build$'
need "$api_df" '^FROM alpine:3\.20@sha256:[0-9a-f]{64}$'
need "$api_df" '^HEALTHCHECK '
need "$api_df" '/api/v1/health'

web_df="$ROOT/apps/web/Dockerfile"
need "$web_df" '^USER 65532:65532'
need "$web_df" 'COPY package.json pnpm-lock.yaml pnpm-workspace.yaml'
need "$web_df" 'pnpm install --frozen-lockfile'

compose="$ROOT/docker-compose.yml"
need "$compose" 'user: "65532:65532"'
need "$compose" 'dockerfile: apps/web/Dockerfile'
need "$compose" '/app/apps/web/.next/cache'
need "$compose" 'read_only: true'
need "$compose" 'no-new-privileges:true'
need "$compose" '[[:space:]]+- ALL'
need "$compose" 'mem_limit: 512m'
need "$compose" 'http://127.0.0.1:8080/api/v1/health'
need "$compose" 'disable: true'

deploy="$ROOT/deploy/k8s/api-deployment.yaml"
need "$deploy" 'runAsUser: 65532'
need "$deploy" 'runAsGroup: 65532'
need "$deploy" 'runAsNonRoot: true'
need "$deploy" 'readOnlyRootFilesystem: true'
need "$deploy" 'allowPrivilegeEscalation: false'
need "$deploy" '[[:space:]]+- ALL'
need "$deploy" 'seccompProfile:'
need "$deploy" 'limits:'
need "$deploy" 'replicas: 2'
need "$deploy" 'maxUnavailable: 0'
need "$deploy" 'podAntiAffinity:'
need "$deploy" 'kubernetes.io/hostname'
need "$deploy" 'terminationGracePeriodSeconds: 45'
need "$deploy" 'preStop:'
need "$deploy" 'command: \["sleep", "15"\]'
need "$deploy" 'secretRef:'
need "$deploy" 'name: flowforge-api'
need "$deploy" 'name: FLOWFORGE_REPLICAS'
need "$deploy" 'value: "2"'
forbid "$deploy" 'sessionAffinity:'
forbid "$deploy" 'replicas: 1'
forbid "$deploy" 'name: JOB_BINDING_SECRET'
forbid "$deploy" 'name: SCRIPT_SIGNING_KEY'
forbid "$deploy" 'image:.*:latest([[:space:]]|$)'

web="$ROOT/deploy/k8s/web-deployment.yaml"
need "$web" 'runAsUser: 65532'
need "$web" 'runAsGroup: 65532'
need "$web" 'runAsNonRoot: true'
need "$web" 'readOnlyRootFilesystem: true'
need "$web" 'allowPrivilegeEscalation: false'
need "$web" 'automountServiceAccountToken: false'
need "$web" '[[:space:]]+- ALL'
need "$web" 'seccompProfile:'
need "$web" 'limits:'
need "$web" 'ghcr.io/bbengt1/flowforge-web:foundation'
need "$web" 'command: \["node", "apps/web/server.js"\]'
need "$web" 'API_INTERNAL_URL'
need "$web" 'http://flowforge-api:8080'
need "$web" 'mountPath: /tmp'
need "$web" 'mountPath: /app/apps/web/.next/cache'
need "$web" 'path: /'
need "$web" 'replicas: 2'
need "$web" 'maxUnavailable: 0'
need "$web" 'podAntiAffinity:'
need "$web" 'kubernetes.io/hostname'
need "$web" 'terminationGracePeriodSeconds: 45'
need "$web" 'preStop:'
need "$web" 'command: \["sleep", "15"\]'
forbid "$web" 'replicas: 1'
forbid "$web" 'image:.*:latest([[:space:]]|$)'
forbid "$web" '://localhost'
forbid "$web" '://127\.0\.0\.1'
forbid "$web" 'name: TRUSTED_DEV_IDENTITY_HEADERS'
forbid "$web" 'name: SEED_LOCAL_DEFAULTS'
forbid "$web" '/usr/local/bin/worker'

need "$ROOT/deploy/k8s/web-service.yaml" 'port: 3000'
need "$ROOT/deploy/k8s/web-networkpolicy.yaml" 'port: 3000'
need "$ROOT/deploy/k8s/web-networkpolicy.yaml" 'port: 8080'
need "$ROOT/deploy/k8s/web-networkpolicy.yaml" 'port: 53'
forbid "$ROOT/deploy/k8s/web-networkpolicy.yaml" '0\.0\.0\.0/0'
forbid "$ROOT/deploy/k8s/web-networkpolicy.yaml" '::/0'
need "$ROOT/deploy/k8s/kustomization.yaml" 'web-deployment.yaml'
need "$ROOT/deploy/k8s/kustomization.yaml" 'web-service.yaml'
need "$ROOT/deploy/k8s/kustomization.yaml" 'web-networkpolicy.yaml'
need "$ROOT/deploy/k8s/ingress.yaml" 'app.example.com'
need "$ROOT/deploy/k8s/ingress.yaml" 'flowforge-web'
need "$ROOT/deploy/k8s/ingress.yaml" 'number: 3000'
if grep -REq 'command:.*\/usr\/local\/bin\/worker' "$ROOT/deploy/k8s"; then
  echo "forbidden compose worker command in deploy/k8s" >&2
  fail=1
fi

prod_runner="$ROOT/deploy/k8s/runner-deployment.yaml"
need "$prod_runner" 'runAsUser: 65532'
need "$prod_runner" 'runAsGroup: 65532'
need "$prod_runner" 'runAsNonRoot: true'
need "$prod_runner" 'readOnlyRootFilesystem: true'
need "$prod_runner" 'allowPrivilegeEscalation: false'
need "$prod_runner" 'automountServiceAccountToken: false'
need "$prod_runner" '[[:space:]]+- ALL'
need "$prod_runner" 'seccompProfile:'
need "$prod_runner" 'command: \["/usr/local/bin/runner"\]'
need "$prod_runner" 'serviceAccountName: flowforge-runner-scripts'
need "$prod_runner" 'SCRIPT_RUNNER_API_SERVER'
need "$prod_runner" 'SCRIPT_RUNNER_TOKEN_FILE'
need "$prod_runner" 'replicas: 2'
need "$prod_runner" 'maxUnavailable: 0'
need "$prod_runner" 'podAntiAffinity:'
need "$prod_runner" 'kubernetes.io/hostname'
need "$prod_runner" 'terminationGracePeriodSeconds: 40'
need "$prod_runner" 'name: WORKER_ID'
need "$prod_runner" 'fieldPath: metadata.name'
need "$prod_runner" 'WORKER_DRAIN_TIMEOUT'
need "$prod_runner" 'value: "30s"'
need "$prod_runner" 'secretRef:'
need "$prod_runner" 'name: flowforge-api'
forbid "$prod_runner" 'replicas: 1'
forbid "$prod_runner" 'value: production-runner'
forbid "$prod_runner" 'name: JOB_BINDING_SECRET'
forbid "$prod_runner" 'name: SCRIPT_SIGNING_KEY'
forbid "$prod_runner" 'image:.*:latest([[:space:]]|$)'
need "$ROOT/deploy/k8s/runner-networkpolicy.yaml" 'port: 5432'

need "$ROOT/deploy/k8s/default-deny-networkpolicy.yaml" 'policyTypes:'
need "$ROOT/deploy/k8s/api-networkpolicy.yaml" 'port: 8080'
need "$ROOT/deploy/k8s/api-networkpolicy.yaml" 'port: 5432'
forbid "$ROOT/deploy/k8s/api-service.yaml" 'sessionAffinity:'
forbid "$ROOT/deploy/k8s/web-service.yaml" 'sessionAffinity:'
need "$ROOT/deploy/k8s/ingress.yaml" '^  tls:'
need "$ROOT/deploy/k8s/api-configmap.yaml" 'REQUIRE_TLS: "true"'
need "$ROOT/deploy/k8s/api-configmap.yaml" 'SHUTDOWN_TIMEOUT: "25s"'
need "$ROOT/deploy/k8s/api-secret.example.yaml" 'JOB_BINDING_SECRET:'
need "$ROOT/deploy/k8s/api-secret.example.yaml" 'SCRIPT_SIGNING_KEY:'

for component in api web runner; do
  pdb="$ROOT/deploy/k8s/${component}-pdb.yaml"
  hpa="$ROOT/deploy/k8s/${component}-hpa.yaml"
  need "$pdb" '^kind: PodDisruptionBudget$'
  need "$pdb" 'maxUnavailable: 1'
  need "$pdb" "component: ${component}"
  need "$hpa" '^kind: HorizontalPodAutoscaler$'
  need "$hpa" 'minReplicas: 2'
  need "$hpa" 'kind: Deployment'
  need "$hpa" "name: flowforge-${component}"
  need "$ROOT/deploy/k8s/kustomization.yaml" "${component}-pdb.yaml"
  need "$ROOT/deploy/k8s/kustomization.yaml" "${component}-hpa.yaml"
done

backup_cj="$ROOT/deploy/k8s/backup-cronjob.yaml"
need "$backup_cj" '^kind: CronJob$'
need "$backup_cj" 'name: flowforge-db-backup'
need "$backup_cj" 'schedule: "0 2 \* \* \*"'
need "$backup_cj" 'ghcr.io/bbengt1/flowforge-backup:foundation'
need "$backup_cj" 'command: \["/usr/local/bin/run-encrypted-backup"\]'
need "$backup_cj" 'BACKUP_REQUIRE_S3'
need "$backup_cj" 'runAsUser: 65532'
need "$backup_cj" 'runAsNonRoot: true'
need "$backup_cj" 'readOnlyRootFilesystem: true'
need "$backup_cj" 'allowPrivilegeEscalation: false'
need "$backup_cj" 'automountServiceAccountToken: false'
need "$backup_cj" '[[:space:]]+- ALL'
need "$backup_cj" 'seccompProfile:'
need "$backup_cj" 'limits:'
need "$backup_cj" 'secretKeyRef:'
need "$backup_cj" 'name: flowforge-backup'
forbid "$backup_cj" 'image:.*:latest([[:space:]]|$)'
forbid "$backup_cj" 'BACKUP_ENCRYPTION_KEY: [^$\n]'
need "$ROOT/deploy/k8s/backup-networkpolicy.yaml" 'component: backup'
need "$ROOT/deploy/k8s/backup-networkpolicy.yaml" 'port: 5432'
need "$ROOT/deploy/k8s/backup-networkpolicy.yaml" 'port: 53'
forbid "$ROOT/deploy/k8s/backup-networkpolicy.yaml" '0\.0\.0\.0/0'
forbid "$ROOT/deploy/k8s/backup-networkpolicy.yaml" '::/0'
need "$ROOT/deploy/k8s/backup-secret.example.yaml" 'BACKUP_ENCRYPTION_KEY:'
need "$ROOT/deploy/k8s/backup-secret.example.yaml" 'BACKUP_S3_BUCKET:'
need "$ROOT/deploy/k8s/postgres-networkpolicy.yaml" 'component: backup'
need "$ROOT/deploy/k8s/kustomization.yaml" 'backup-cronjob.yaml'
need "$ROOT/deploy/k8s/kustomization.yaml" 'backup-networkpolicy.yaml'
need "$ROOT/deploy/k8s/kustomization.yaml" 'backup-secret.example.yaml'

backup_df="$ROOT/scripts/backup/Dockerfile"
need "$backup_df" '^USER 65532:65532'
need "$backup_df" '^FROM alpine:3\.20@sha256:[0-9a-f]{64}$'
need "$backup_df" 'postgresql16-client'
need "$backup_df" 'py3-cryptography'
need "$backup_df" 'run-encrypted-backup'
need "$backup_df" 'aead.py'
forbid "$backup_df" ':latest'
need "$ROOT/scripts/backup/aead.py" 'FFB1'
need "$ROOT/scripts/backup/aead.py" 'AESGCM'
need "$ROOT/scripts/backup/aead.py" '600_000'

runner="$ROOT/deploy/kubernetes/script-runner-deployment.yaml"
need "$runner" '^kind: Job$'
need "$runner" 'restartPolicy: Never'
need "$runner" 'ghcr.io/bbengt1/flowforge-script-runner:foundation'
need "$runner" 'runAsUser: 65532'
need "$runner" 'runAsNonRoot: true'
need "$runner" 'readOnlyRootFilesystem: true'
need "$runner" 'allowPrivilegeEscalation: false'
need "$runner" 'automountServiceAccountToken: false'
need "$runner" '[[:space:]]+- ALL'
need "$runner" 'seccompProfile:'
need "$runner" '/workspace'
forbid "$runner" 'docker.sock'
forbid "$runner" 'image:.*:latest([[:space:]]|$)'
forbid "$runner" '^[[:space:]]*replicas:'

sr_df="$ROOT/apps/api/Dockerfile.script-runner"
need "$sr_df" '^USER 65532:65532'
need "$sr_df" '^FROM golang:1\.26-alpine@sha256:[0-9a-f]{64} AS build$'
need "$sr_df" '^FROM golang:1\.26-alpine@sha256:[0-9a-f]{64}$'
need "$sr_df" '/usr/local/bin/scriptrunner'
forbid "$sr_df" ':latest'

need "$ROOT/deploy/kubernetes/script-runner-networkpolicy.yaml" 'policyTypes:'
need "$ROOT/deploy/kubernetes/script-runner-networkpolicy.yaml" 'port: 53'
need "$ROOT/deploy/kubernetes/script-runner-networkpolicy.yaml" '\$\{CONTROL_PLANE_API_CIDR\}'
need "$ROOT/deploy/kubernetes/script-runner-networkpolicy.yaml" 'ipBlock:'
need "$ROOT/deploy/kubernetes/script-runner-networkpolicy.yaml" 'port: 443'
forbid "$ROOT/deploy/kubernetes/script-runner-networkpolicy.yaml" '0\.0\.0\.0/0'
forbid "$ROOT/deploy/kubernetes/script-runner-networkpolicy.yaml" '::/0'
need "$ROOT/deploy/k8s/runner-controlplane-networkpolicy.yaml" '\$\{CONTROL_PLANE_API_CIDR\}'
need "$ROOT/deploy/k8s/runner-controlplane-networkpolicy.yaml" 'port: 443'
forbid "$ROOT/deploy/k8s/runner-controlplane-networkpolicy.yaml" '0\.0\.0\.0/0'
forbid "$ROOT/deploy/k8s/runner-networkpolicy.yaml" '0\.0\.0\.0/0'
need "$ROOT/deploy/k8s/script-runner-rbac.yaml" 'networkpolicies'

if [[ "$fail" -eq 0 ]]; then
  echo "deploy defaults ok"
fi
exit "$fail"
