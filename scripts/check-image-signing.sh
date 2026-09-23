#!/usr/bin/env bash
# Fail closed unless image signing, attestations, and admission are wired.
# Mutable FlowForge image refs fail. The retired provenance script must fail.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
fail=0

err() {
  echo "$*" >&2
  fail=1
}

need() {
  local file="$1"
  local pattern="$2"
  if ! grep -Eq -- "$pattern" "$file"; then
    err "missing /$pattern/ in ${file#"$ROOT/"}"
  fi
}

forbid() {
  local file="$1"
  local pattern="$2"
  if grep -Eq -- "$pattern" "$file"; then
    err "forbidden /$pattern/ in ${file#"$ROOT/"}"
  fi
}

# --- retired unsigned provenance -------------------------------------------
prov="$ROOT/scripts/write-provenance.sh"
tmp="$(mktemp -d)"
if bash "$prov" "flowforge-api:ci" "$tmp/out.json"; then
  err "write-provenance.sh exited 0"
fi
if [[ -e "$tmp/out.json" ]]; then
  err "write-provenance.sh wrote a provenance file"
fi
rm -rf "$tmp"
forbid "$prov" 'predicateType'
forbid "$prov" 'slsa.dev/provenance'

# --- admission manifests ----------------------------------------------------
kyverno="$ROOT/deploy/kyverno/flowforge-verify-images.yaml"
kyverno_k="$ROOT/deploy/kyverno/kustomization.yaml"
key_example="$ROOT/deploy/kyverno/flowforge-verify-images-key.example.yaml"
vap="$ROOT/deploy/admission/image-digest-policy.yaml"
wf="$ROOT/.github/workflows/supply-chain.yml"

need "$kyverno_k" 'flowforge-verify-images.yaml'
forbid "$kyverno_k" 'flowforge-verify-images-key.example.yaml'
need "$ROOT/deploy/admission/kustomization.yaml" 'image-digest-policy.yaml'
forbid "$ROOT/deploy/k8s/kustomization.yaml" 'image-digest-policy.yaml'

need "$kyverno" '^kind: ClusterPolicy$'
need "$kyverno" 'validationFailureAction: Enforce'
need "$kyverno" 'failurePolicy: Fail'
need "$kyverno" 'background: false'
need "$kyverno" 'mutateDigest: false'
need "$kyverno" 'verifyDigest: true'
need "$kyverno" 'required: true'
need "$kyverno" 'predicateType: https://slsa.dev/provenance/v1'
need "$kyverno" 'issuer: "https://token.actions.githubusercontent.com"'
need "$kyverno" 'subject: "https://github.com/bbengt1/flowforge/.github/workflows/supply-chain.yml@refs/heads/main"'
need "$kyverno" 'url: https://rekor.sigstore.dev'
need "$kyverno" 'ghcr.io/bbengt1/flowforge-api\*'
need "$kyverno" 'ghcr.io/bbengt1/flowforge-web\*'
need "$kyverno" 'ghcr.io/bbengt1/flowforge-script-runner\*'
need "$kyverno" 'ghcr.io/bbengt1/flowforge-backup\*'
forbid "$kyverno" 'validationFailureAction: Audit'
forbid "$kyverno" 'BEGIN PUBLIC KEY'
forbid "$kyverno" 'BEGIN PRIVATE KEY'

need "$key_example" 'REPLACE_WITH_COSIGN_PUBLIC_KEY'
need "$key_example" 'validationFailureAction: Enforce'
need "$key_example" 'verifyDigest: true'
need "$key_example" 'mutateDigest: false'
forbid "$key_example" 'BEGIN PUBLIC KEY'
forbid "$key_example" 'BEGIN PRIVATE KEY'
if grep -REq 'BEGIN (PUBLIC|PRIVATE) KEY' "$ROOT/deploy/kyverno"; then
  err "deploy/kyverno contains a key block"
fi

need "$vap" '^kind: ValidatingAdmissionPolicy$'
need "$vap" 'failurePolicy: Fail'
need "$vap" '^kind: ValidatingAdmissionPolicyBinding$'
need "$vap" 'validationActions:'
need "$vap" '- Deny'
need "$vap" 'ghcr.io/bbengt1/flowforge-'
need "$vap" '@sha256:'
forbid "$vap" 'validationActions: \[Warn\]'

# --- workflow: sign, attest, HIGH image gate --------------------------------
need "$wf" 'sigstore/cosign-installer@v4'
need "$wf" 'cosign-release: v2.5.3'
need "$wf" 'cosign sign --yes'
need "$wf" 'actions/attest-build-provenance@v4'
need "$wf" 'push-to-registry: true'
need "$wf" 'id-token: write'
need "$wf" 'attestations: write'
need "$wf" 'packages: write'
need "$wf" 'provenance: false'
need "$wf" 'refs/heads/main'
need "$wf" 'refusing to sign'
forbid "$wf" 'write-provenance.sh'
forbid "$wf" 'continue-on-error'
forbid "$wf" 'cosign sign --key'

if grep -n -- '--severity' "$wf" | grep -v 'HIGH,CRITICAL'; then
  err "supply-chain.yml severity is not HIGH,CRITICAL"
fi

image_scans="$(grep -c 'trivy image' "$wf" || true)"
if [[ "$image_scans" -lt 4 ]]; then
  err "expected at least 4 trivy image scans, found $image_scans"
fi

# --- FlowForge image refs ---------------------------------------------------
# The script-runner template tag is an identity check in
# apps/api/internal/scripts/jobruntime.go. RenderScriptJob rewrites the
# submitted Job to repository@<runtime profile imageDigest> before create.
# Admission sees that digest. The template itself must not be applied.
template_image='ghcr.io/bbengt1/flowforge-script-runner:foundation'
template_files=(
  "$ROOT/deploy/kubernetes/script-runner-deployment.yaml"
  "$ROOT/apps/api/internal/scripts/script_runner_job.yaml"
)
if ! cmp -s "${template_files[0]}" "${template_files[1]}"; then
  err "script-runner template drifted from the embedded copy"
fi

pin_re='^ghcr\.io/bbengt1/flowforge-[a-z0-9-]+(:[A-Za-z0-9._-]+)?@sha256:[0-9a-f]{64}$'

is_template() {
  local file="$1"
  local t
  for t in "${template_files[@]}"; do
    [[ "$file" == "$t" ]] && return 0
  done
  return 1
}

# check_file_images <file> <pinned|template> [quiet]
# quiet=1 suppresses the per-ref message (self-test). Exit 1 on a bad ref.
check_file_images() {
  local file="$1"
  local mode="$2"
  local quiet="${3:-0}"
  local line image found=0 bad=0
  while IFS= read -r line; do
    [[ "$line" =~ ^[[:space:]]*# ]] && continue
    [[ "$line" =~ ^[[:space:]]*image:[[:space:]]*([^[:space:]]+) ]] || continue
    image="${BASH_REMATCH[1]}"
    [[ "$image" == ghcr.io/bbengt1/flowforge-* ]] || continue
    found=1
    if [[ "$image" == *":latest"* ]]; then
      [[ "$quiet" -eq 0 ]] && echo "mutable latest ref in ${file#"$ROOT/"}: $image" >&2
      bad=1
      continue
    fi
    if [[ "$mode" == template ]]; then
      if [[ "$image" != "$template_image" ]]; then
        [[ "$quiet" -eq 0 ]] && echo "script-runner template image must be $template_image (got $image)" >&2
        bad=1
      fi
      continue
    fi
    if [[ ! "$image" =~ $pin_re ]]; then
      [[ "$quiet" -eq 0 ]] && echo "mutable or unpinned FlowForge ref in ${file#"$ROOT/"}: $image" >&2
      bad=1
    fi
  done < "$file"
  if [[ "$found" -eq 0 && "$mode" == template ]]; then
    [[ "$quiet" -eq 0 ]] && echo "script-runner template has no image ref: ${file#"$ROOT/"}" >&2
    bad=1
  fi
  return "$bad"
}

scan_tree() {
  local dir="$1"
  local file
  while IFS= read -r file; do
    if is_template "$file"; then
      check_file_images "$file" template || fail=1
    else
      check_file_images "$file" pinned || fail=1
    fi
  done < <(find "$dir" -type f \( -name '*.yaml' -o -name '*.yml' \))
}

scan_tree "$ROOT/deploy/k8s"
scan_tree "$ROOT/deploy/kubernetes"
check_file_images "${template_files[1]}" template || fail=1

need "$ROOT/apps/api/internal/scripts/jobruntime.go" 'ScriptRunnerRepository \+ ":" \+ ScriptRunnerTag'

# Self-test: a mutable ref fails and a digest pin passes.
self="$(mktemp)"
printf 'image: ghcr.io/bbengt1/flowforge-api:foundation\n' > "$self"
if check_file_images "$self" pinned 1; then
  err "self-test accepted a mutable tag"
fi
printf 'image: ghcr.io/bbengt1/flowforge-api:foundation@sha256:%s\n' "$(printf 'ab%.0s' {1..32})" > "$self"
if ! check_file_images "$self" pinned 1; then
  err "self-test rejected a digest pin"
fi
printf 'image: ghcr.io/bbengt1/flowforge-api:latest\n' > "$self"
if check_file_images "$self" pinned 1; then
  err "self-test accepted :latest"
fi
rm -f "$self"

if [[ "$fail" -eq 0 ]]; then
  echo "image signing checks ok"
fi
exit "$fail"
