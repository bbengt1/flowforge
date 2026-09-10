# E12.1 security verification suite

Relates to #182 / Part of #181. **Keep #182 open** — Chloe UI evidence
is linked below; do not close on this map alone. This document is the
control map, how each control is tested, and the Chloe surface list.

Harness: `scripts/e12-security-suite.sh` (catalog
`scripts/e12-security-suite.json`). CI job: `.github/workflows/e12-security.yml`
(`Security verification suite`). Last-run pointer:
[e12-security-evidence/last-run.json](e12-security-evidence/last-run.json).

The suite **wires existing** Go unit/integration tests, web contract tests,
and supply-chain scripts. It does not weaken ADV hardenings. A failed
domain fails the PR/main job.

## How to run

```bash
# Unit + contract + provenance fixtures (no Postgres)
bash scripts/e12-security-suite.sh

# Include durable Postgres paths (jti, RLS, session revoke, dispatch)
TEST_DATABASE_URL='postgres://flowforge:…@127.0.0.1:5432/flowforge?sslmode=disable' \
  bash scripts/e12-security-suite.sh
```

CI starts Postgres 16 and sets `TEST_DATABASE_URL` so skipped integration
tests become required.

## Controls and how they are tested

| # | Domain | Primary proof | Representative tests |
| --- | --- | --- | --- |
| 1 | Identity / session / embed replay / key rotation | Go + web | `internal/embed` (`TestJTIReplayRejected`, overlap/rotate); `httpapi` `TestEmbedExchangeReplayConflict`, `TestEmbedKeyRotationRequiresPlatformAdminAndPriorActiveKey`, `TestFailClosed*`, `TestDeleteWorkspaceRevokesBoundEmbedSession`, `TestSession*`, `TestPortalReplayFailsClosed`; web embed/session/CHIPS/CSRF contracts |
| 2 | Webhook safety (HMAC, replay, opaque IDs) | Go + web | `internal/webhook` `TestSignAndVerifyRawBody`, `TestMemoryReplayRateAndTenancy`; `httpapi` `TestWebhookIngressValidAndFailClosed` (bad HMAC, skew, oversize, unknown id, replay `409`, rate); `TestWebhookTriggerCRUDRotateAndTenancy` (opaque public id, rotate, no secret in URL/body) |
| 3 | Cross-workspace isolation | Go + web | `internal/isolation` memory + `TestPostgresRLSUnsetStaleAndCrossWorkspace`; `httpapi` `TestIsolationAPIRejectsCrossWorkspaceSurfaces`; `wfstore` `TestJobTicketRejectsAlteredExpiredAndCrossWorkspace`; web `isolation-exercises.test.ts` |
| 4 | Approval expiry | Go + web | `approval` `TestMemorySelfApprovalAndExpiry`; `httpapi` `TestApprovalExpiryRecheckedServerSide` (decide after expiry → `409`); `policy` `TestEvaluateRequireApprovalBindsVersionTargetPolicyAndExpiry` |
| 5 | Credential and artifact revocation | Go + web | `vault` ciphertext / disablement; `httpapi` `TestCredentialVaultRBACAndDisablement`, `TestScriptRevokeAndEmergencyStop`; `scripts` `TestRevokeBlocksDispatchAndIsSecretFree`; session revoke on workspace delete |
| 6 | Artifact / output authorization / redaction / legal holds | Go + web | `httpapi` `TestArtifactUploadDownloadRetentionAndHold`; `wfstore` `TestMemoryArtifactHoldAndPurgePlan`, `TestMemoryDownloadGrantExpiry`; `artifact` scan/redact; `observability` / `httpnotify` / Kubernetes / SSH secret-free output |
| 7 | Stale-worker fencing | Go | `httpapi` `TestDispatchClaimFenceCancelAndLeaseLoss`; `wfstore` `TestMemoryDispatchLeaseFenceCancelRetry`, `TestPostgresDispatchSkipLockedAndLeaseLoss` (two valid single-node executions — a disconnected two-node graph is rejected); job-ticket tamper |
| 8 | Provider failure behavior | Go + web | Kubernetes apply/rollout fail-closed (no force, timeout leaves resource, policy deny does not contact cluster); SSH/script lease-loss → `indeterminate`, no blind retry; emergency stop |
| 9 | SSRF / redirect / DNS-rebinding (ADV-010) | Go + web | `httpnotify` `TestSSRFDenied`, `TestDNSRebindingDenied`, `TestRedirectToPrivateDenied`, `TestMetadataStillDeniedWhenPrivateAllowed`, IPv6 IMDS; SSH `TestAddressAllowlistAndDNSRebinding`; policy CIDR; `allowPrivateDestinations` fail-closed / wrong-kind ignored |
| 10 | Dependency / image provenance | Scripts + sibling CI | Suite: `check-approved-bases.sh`, `check-deploy-defaults.sh`, `govulncheck-gate.py` fixtures. **Sibling (required on the same PR):** `supply-chain.yml` `govulncheck` + `image-scan` (Trivy fs HIGH/CRITICAL, image CRITICAL, SPDX SBOM, `write-provenance.sh`). Policy: [supply-chain/policy.md](../../deploy/supply-chain/policy.md) |

Postgres-backed rows in last-run.json (`databaseUrlSet: true`) are the
durable proof for `jti` consume, RLS, session revoke, and skip-locked
lease loss. Memory stores cover the same negatives when the DSN is unset.

## Last-run pointer

- Machine summary: [e12-security-evidence/last-run.json](e12-security-evidence/last-run.json)
  (`ranAt`, `gitSha`, per-domain `go`/`web`/`scripts` counts).
- CI artifact name: `e12-security-suite` (same JSON from the GitHub Actions job).
- ADV-013 two-origin embed/Portal screenshots remain under
  [adv-013-evidence](adv-013-evidence/README.md) (issue #144 stays open).
- Chloe Hit-list pointer:
  [e12-security-evidence/chloe-ui-last-run.json](e12-security-evidence/chloe-ui-last-run.json)
  · notes [chloe-ui.md](e12-security-evidence/chloe-ui.md).

Re-run the harness and commit an updated `last-run.json` when a domain’s
tests change. Do not hand-edit pass/fail flags.

## Chloe map

Prefer API/harness proof. Chloe adds UI evidence only where a browser
surface can disagree with the API (cookies, chrome, masked secrets).

| Surface | Route / component | Why | Suite already proves | Chloe gap |
| --- | --- | --- | --- | --- |
| Embed exchange + replay | `/embed/v1…` · `EmbedExchangeGate` | Body-only assertion, CHIPS cookies, replay `409`, host/ctx bind | Mint/exchange/replay/rotate/nbf/jti Go tests; web embed contracts | **Done.** Iframe `/embed/v1` body-only postMessage/form; replay same assertion → ProblemBanner `Conflict (409)`. Chrome from `GET /session` `session.embed` (ADV-021), not host query. Tests: [e12-chloe-ui-contract.test.ts](../../apps/web/src/lib/e12-chloe-ui-contract.test.ts). Evidence: [chloe-ui.md](e12-security-evidence/chloe-ui.md) · [embed-replay-409.svg](e12-security-evidence/embed-replay-409.svg). |
| Session chrome | `EmbedChrome`, `SessionStatusChip`, `SessionExpiryBanner` | Idle/absolute expiry and workspace-delete revoke are `401` | `TestStaleSessionFailsClosed`, ADV-019 workspace-delete tests | **Done.** 401 latch reuses existing stale chrome (`Session stale` / `Stale session`); expired still uses existing countdown copy. No new chrome. Tests: same Chloe contract + [session.test.ts](../../apps/web/src/lib/session.test.ts). Evidence: [session-stale-401.svg](e12-security-evidence/session-stale-401.svg). |
| Portal host | `/portal` · `PortalHost` + ADV-013 origins | Portal mint → embed iframe; hostile ancestor blocked | `httpapi` Portal tests; `adv013-cross-origin.sh` + [adv-013-evidence](adv-013-evidence/README.md) | **Optional** if #144 screenshots are current: Portal mount + `evil.test` blocked iframe. Do not re-prove HMAC/SSRF here. |
| Approvals | `/approvals` · `ApprovalValidityBanner`, `ApprovalDecideControls` | Expired / rebound approval cannot decide | `TestApprovalExpiryRecheckedServerSide` | **Done.** Expired row shows `Approval expired` banner; Approve/Reject stay disabled. Tests: Chloe contract + [approval.test.ts](../../apps/web/src/lib/approval.test.ts). Evidence: [approval-expired.svg](e12-security-evidence/approval-expired.svg). |
| Credentials | `/credentials` vault | Disable/rotate; no plaintext | Vault Go tests; web credential contracts | **Optional:** confirm secret fields stay masked after rotate/disable. |
| Script revoke | `ScriptPublishStatus` | Revoked digest cannot start | `TestScriptRevokeAndEmergencyStop` | **Optional:** revoke badge + start `409` copy. |
| Artifacts / legal hold | `/executions/{id}` · `ExecutionArtifacts` | Authz download grant, hold blocks purge, redaction | `TestArtifactUploadDownloadRetentionAndHold` | **Optional:** legal-hold badge and denied foreign-workspace download. |
| Isolation operator | `/isolation` | Cross-workspace clicks | Isolation API + exercises contract | **Optional:** click-through; API is sufficient for E12.1. |
| Webhook admin | `WebhookTriggerPanel` | Opaque id, rotate, secret never in URL | Webhook ingress + CRUD Go tests | **Optional:** confirm secret not shown; rotate issues a new secret once. |
| SSRF / fencing / provider / provenance | none | No product UI | Suite + `supply-chain.yml` | **None.** Do not add operator screens. |

### Not Chloe

Outbound HTTP SSRF (ADV-010), stale-worker fencing, Kubernetes/SSH/script
provider failure, Trivy/SBOM/approved-bases. Those stay harness/CI-only.

## Ownership

- **jonny:** harness, API/engine negatives, CI gate, this map.
- **Chloe:** UI/embed rows marked **Done** (Hit list). Optional rows
  remain open if she wants extra screenshots on #182. Keep the issue
  open after this PR.
