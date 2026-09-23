#!/usr/bin/env bash
# Shared helpers for scripts/backup. Source this file; do not execute it.
# Never prints BACKUP_ENCRYPTION_KEY, DATABASE_URL, POSTGRES_PASSWORD,
# or object-store credentials.

if [[ "${BASH_SOURCE[0]}" == "$0" ]]; then
  echo "source common.sh; do not execute it" >&2
  exit 1
fi

if [[ -n "${FLOWFORGE_BACKUP_COMMON:-}" ]]; then
  return 0
fi
FLOWFORGE_BACKUP_COMMON=1

_BACKUP_LIB_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

backup_resolve_tools() {
  if [[ -f "${_BACKUP_LIB_DIR}/aead.py" && -f "${_BACKUP_LIB_DIR}/manifest.py" ]]; then
    BACKUP_AEAD="${_BACKUP_LIB_DIR}/aead.py"
    BACKUP_MANIFEST="${_BACKUP_LIB_DIR}/manifest.py"
  elif [[ -f /usr/local/lib/flowforge/aead.py && -f /usr/local/lib/flowforge/manifest.py ]]; then
    BACKUP_AEAD="/usr/local/lib/flowforge/aead.py"
    BACKUP_MANIFEST="/usr/local/lib/flowforge/manifest.py"
  else
    echo "aead.py helper missing" >&2
    return 1
  fi
  if ! command -v python3 >/dev/null 2>&1; then
    echo "python3 is required for AEAD seal" >&2
    return 1
  fi
}

backup_assert_ffb1() {
  local file="$1"
  local magic
  if [[ ! -s "$file" ]]; then
    echo "encrypted blob is empty" >&2
    return 1
  fi
  magic="$(head -c 4 "$file" | LC_ALL=C od -An -tx1 | tr -d ' \n')"
  if [[ "$magic" != "46464231" ]]; then
    echo "backup blob is not FFB1 AEAD" >&2
    return 1
  fi
}

# Print a postgres/aws failure without echoing a DSN or key that landed in the text.
backup_filter_err() {
  local err="$1"
  if [[ ! -s "$err" ]]; then
    echo "command failed" >&2
    return 0
  fi
  if grep -qE 'postgres(ql)?://|PASSWORD=|BACKUP_ENCRYPTION_KEY|AWS_SECRET|AKIA' "$err"; then
    echo "command failed" >&2
    return 0
  fi
  cat "$err" >&2
}

backup_wal_object_name() {
  case "$1" in
    *.history) printf '%s.enc\n' "$1" ;;
    *) printf '%s.wal.enc\n' "$1" ;;
  esac
}

backup_validate_wal_name() {
  local name="$1"
  if [[ "$name" =~ ^[0-9A-F]{24}$ ]]; then
    return 0
  fi
  if [[ "$name" =~ ^[0-9A-F]{8}\.history$ ]]; then
    return 0
  fi
  echo "WAL filename rejected" >&2
  return 1
}

backup_s3_prefix() {
  local prefix="${BACKUP_S3_PREFIX:-flowforge-db}"
  prefix="${prefix#/}"
  prefix="${prefix%/}"
  if [[ -z "$prefix" || "$prefix" == *..* || "$prefix" == *" "* || "$prefix" == /* ]]; then
    echo "BACKUP_S3_PREFIX is invalid" >&2
    return 1
  fi
  printf '%s\n' "$prefix"
}

backup_s3_ready() {
  if [[ -z "${BACKUP_S3_BUCKET:-}" ]]; then
    if [[ "${BACKUP_REQUIRE_S3:-}" == "1" ]]; then
      echo "BACKUP_S3_BUCKET is required when BACKUP_REQUIRE_S3=1" >&2
      return 1
    fi
    return 2
  fi
  if ! command -v aws >/dev/null 2>&1; then
    echo "BACKUP_S3_BUCKET is set but aws CLI is not installed" >&2
    return 1
  fi
  : "${AWS_ACCESS_KEY_ID:?AWS_ACCESS_KEY_ID is required when BACKUP_S3_BUCKET is set}"
  : "${AWS_SECRET_ACCESS_KEY:?AWS_SECRET_ACCESS_KEY is required when BACKUP_S3_BUCKET is set}"
  return 0
}

# Upload one ciphertext object. Key is relative to BACKUP_S3_PREFIX
# (for example name.sql.enc or wal/name.wal.enc). No-op when S3 is unset
# unless BACKUP_REQUIRE_S3=1.
backup_s3_upload() {
  local file="$1"
  local key="$2"
  local prefix region status=0 endpoint_args=()
  backup_s3_ready || status=$?
  if [[ "$status" -eq 2 ]]; then
    return 0
  fi
  if [[ "$status" -ne 0 ]]; then
    return 1
  fi
  prefix="$(backup_s3_prefix)"
  if [[ -z "$key" || "$key" == /* || "$key" == *..* || "$key" == *" "* ]]; then
    echo "object key is invalid" >&2
    return 1
  fi
  if [[ -n "${BACKUP_S3_ENDPOINT:-}" ]]; then
    endpoint_args=(--endpoint-url "$BACKUP_S3_ENDPOINT")
  fi
  region="${BACKUP_S3_REGION:-${AWS_DEFAULT_REGION:-us-east-1}}"
  if ! aws s3 cp "$file" "s3://${BACKUP_S3_BUCKET}/${prefix}/${key}" \
    --region "$region" \
    --only-show-errors \
    "${endpoint_args[@]}" >/dev/null; then
    echo "s3 upload failed" >&2
    return 1
  fi
  echo "uploaded encrypted object key=${prefix}/${key}"
}

# Download one object. Returns 0 on success, 2 when the key is absent,
# 1 on any other failure (fail closed — do not start a new chain).
backup_s3_download() {
  local key="$1"
  local dest="$2"
  local prefix region endpoint_args=() err status
  if [[ -z "${BACKUP_S3_BUCKET:-}" ]]; then
    return 2
  fi
  if ! command -v aws >/dev/null 2>&1; then
    echo "BACKUP_S3_BUCKET is set but aws CLI is not installed" >&2
    return 1
  fi
  prefix="$(backup_s3_prefix)"
  if [[ -z "$key" || "$key" == /* || "$key" == *..* || "$key" == *" "* ]]; then
    echo "object key is invalid" >&2
    return 1
  fi
  if [[ -n "${BACKUP_S3_ENDPOINT:-}" ]]; then
    endpoint_args=(--endpoint-url "$BACKUP_S3_ENDPOINT")
  fi
  region="${BACKUP_S3_REGION:-${AWS_DEFAULT_REGION:-us-east-1}}"
  err="$(mktemp)"
  if aws s3 cp "s3://${BACKUP_S3_BUCKET}/${prefix}/${key}" "$dest" \
    --region "$region" \
    --only-show-errors \
    "${endpoint_args[@]}" >/dev/null 2>"$err"; then
    rm -f "$err"
    return 0
  fi
  status=1
  if grep -qiE 'Not Found|404|does not exist|NoSuchKey' "$err"; then
    status=2
  else
    echo "s3 download failed" >&2
  fi
  rm -f "$err"
  return "$status"
}
