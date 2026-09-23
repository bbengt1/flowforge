# KEK rotation

G.2.3 / #448. Operator runbook for the vault data-encryption key (KEK).

The API encrypts each credential and artifact with a random data key
(DEK). The DEK is wrapped with the KEK. Production does not store that
KEK in plaintext. A cloud KMS wraps it, and the process keeps only the
wrapped blob in `CREDENTIAL_KEK_WRAPPED`.

Supported providers: AWS KMS (`aws`), Cloud KMS (`gcp`), Azure Key Vault
(`azure`), HashiCorp Vault Transit (`vault`).

## Hard lines

- Do not log, paste into a ticket, or return the plaintext KEK or DEK.
- `kek-rotate` prints wrapped blobs and counts only.
- Vault APIs stay display-name + UUID. This runbook does not change them.
- Drafts never run. Rotation does not execute workflows.
- Re-encryption sets `app.workspace_id` per workspace. `FORCE RLS` stays on.
- A production-locked process (`APP_ENV` empty or `production`, or
  `REQUIRE_TLS=true`) refuses plaintext `CREDENTIAL_KEK` /
  `CREDENTIAL_KEK_FILE`. Partial `KMS_*` configuration refuses to boot.
- Compose (`APP_ENV=development`) may keep the documented local-only
  plaintext KEK. Do not copy it here.

## What you store

| Variable | Where | Contents |
| --- | --- | --- |
| `KMS_PROVIDER` | Config | `aws`, `gcp`, `azure`, or `vault` |
| Provider key id | Config | CMK ARN, Cloud KMS resource name, Key Vault key, or transit key name. Not the data KEK. |
| Provider credential | Secret | Access key, bearer, or Vault token. Never log it. |
| `CREDENTIAL_KEK_WRAPPED` | Secret | `ff1:…` ciphertext from `kek-rotate`. Not the 32-byte key. |
| `CREDENTIAL_KEK_ID` | Config or Secret | `key_reference` stored on rows. Not the key. Change it when the data KEK changes. |
| `CREDENTIAL_KEK_PREVIOUS_WRAPPED` / `CREDENTIAL_KEK_PREVIOUS_ID` | Secret | Overlap window only. Remove after re-encryption. |

Provider variables (set only the block you use):

| Provider | Required |
| --- | --- |
| `aws` | `KMS_AWS_REGION` (or `AWS_REGION`), `KMS_AWS_KEY_ID` (or `KMS_KEY_ID`), `KMS_AWS_ACCESS_KEY_ID` and `KMS_AWS_SECRET_ACCESS_KEY` (or the standard `AWS_ACCESS_KEY_ID` / `AWS_SECRET_ACCESS_KEY`). Optional `KMS_AWS_SESSION_TOKEN`, `KMS_AWS_ENDPOINT` (https). |
| `gcp` | `KMS_GCP_KEY_NAME` (or `KMS_KEY_ID`) as `projects/…/cryptoKeys/…`, and `KMS_GCP_ACCESS_TOKEN` or `KMS_GCP_TOKEN_FILE`. |
| `azure` | `KMS_AZURE_VAULT_URL` (`https://*.vault.azure.net` and the other sovereign hosts), `KMS_AZURE_KEY_NAME`, `KMS_AZURE_ACCESS_TOKEN` or `KMS_AZURE_TOKEN_FILE`. Optional `KMS_AZURE_KEY_VERSION`. Wrap algorithm defaults to `RSA-OAEP-256` (`A256KW` allowed). |
| `vault` | `KMS_VAULT_ADDR` (https), `KMS_VAULT_KEY_NAME`, `KMS_VAULT_TOKEN` or `KMS_VAULT_TOKEN_FILE`. Mount defaults to `transit`. |

The image includes `/usr/local/bin/kek-rotate`. From a checkout:
`go run ./cmd/kek-rotate` in `apps/api`.

## First wrap

Use this when production has no vault rows yet.

```bash
export KMS_PROVIDER=aws
export KMS_AWS_REGION=us-east-1
export KMS_AWS_KEY_ID=alias/flowforge
export KMS_AWS_ACCESS_KEY_ID=…
export KMS_AWS_SECRET_ACCESS_KEY=…
# APP_ENV=production  — set the real process environment
/usr/local/bin/kek-rotate wrap --generate
```

Copy the two lines into the API secret. Do not also set `CREDENTIAL_KEK`.
Restart the API and the runner. Both must unwrap the blob at boot.
If the KMS call fails, the process exits. Vault create/read stays
fail-closed (`503`) when no key is loaded.

To move an existing non-production plaintext KEK into KMS without
changing the key bytes (rows keep decrypting; no re-encryption):

```bash
export CREDENTIAL_KEK=…          # the current 32-byte key, once
export CREDENTIAL_KEK_ID=…       # the id already stored on rows
/usr/local/bin/kek-rotate wrap
```

Unset `CREDENTIAL_KEK` before the production restart. Put the printed
`CREDENTIAL_KEK_WRAPPED` and the same `CREDENTIAL_KEK_ID` on the secret.

## Rotate the data KEK (online)

Old and new KEKs are both loaded while rows are rewrapped. Encrypt
uses the new key. Decrypt tries the key named on the row, then the
other loaded key. Secret ciphertext is not rewritten. Only the wrapped
DEK and `key_reference` change.

1. Confirm `KMS_PROVIDER` and `CREDENTIAL_KEK_WRAPPED` are set, and
   `CREDENTIAL_KEK` is unset.
2. Run `kek-rotate rotate`. It prints four lines:
   `CREDENTIAL_KEK_PREVIOUS_WRAPPED`, `CREDENTIAL_KEK_PREVIOUS_ID`,
   `CREDENTIAL_KEK_WRAPPED`, `CREDENTIAL_KEK_ID`.
3. Apply those four values. Restart every API and runner replica so
   each process holds both keys. New writes use the new id.
4. Run `kek-rotate reencrypt` with `DATABASE_URL`, the same KMS
   environment, and the process HMAC keys (`JOB_BINDING_SECRET`,
   `SCRIPT_SIGNING_KEY`). It loads config the same way the API does.
   It prints `workspaces`, `credentials`, and `artifacts` counts. It
   does not print key material. A row that cannot be opened stops the
   command. Leave the previous KEK in place until the command exits 0
   and a second run reports zeros.
5. Remove `CREDENTIAL_KEK_PREVIOUS_WRAPPED` and
   `CREDENTIAL_KEK_PREVIOUS_ID`. Restart. Decrypt of leftover rows now
   fails closed until you restore the previous key and re-run step 4.

Do not drop the previous key in the same restart that installs the new
key. Readers still need it until step 4 finishes.

## Rewrap under a new CMK (same data KEK)

Use this when the cloud key changes and the 32-byte data KEK should
stay. No database re-encryption.

1. Give the process decrypt on the key that produced the current blob
   and encrypt on the new key. For AWS, GCP, and Vault the blob carries
   the key id. Point `KMS_*_KEY_ID` / `KMS_KEY_ID` at the new key.
2. Run `kek-rotate rewrap`.
3. Replace `CREDENTIAL_KEK_WRAPPED` with the printed value. Keep
   `CREDENTIAL_KEK_ID`. Restart.

## Fail closed

Boot fails when:

- `KMS_PROVIDER` is set and any required variable for that provider is
  missing, or an endpoint is not https (loopback http is non-production
  only)
- `CREDENTIAL_KEK_WRAPPED` is missing or does not unwrap to 32 bytes
- plaintext `CREDENTIAL_KEK` is set on a production-locked process, or
  is set together with `KMS_PROVIDER`
- the previous wrapped blob is set without `CREDENTIAL_KEK_PREVIOUS_ID`,
  or the two ids are equal

The error names the variable. It does not include key bytes.

## Cadence

Rotate the data KEK on a compromise, on an operator schedule you
record outside this repo, or when the CMK policy requires a new data
key. CMK-only rewrap does not need `reencrypt`. After either change,
confirm a create and a read in a non-production workspace before
removing the previous key.
