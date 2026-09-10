# E12.3 threat-model review (production gate)

Relates to #184 / Part of #181. **Keep #184 open.**

This is a **review of controls that already exist** on `main`. It does
not add features, weaken E12.1 / E12.2, or invent new trust boundaries.
The normative model remains the [security model](security-model.md).
Verification remains the [E12.1 suite](e12-security-verification.md).
Restore / worker-loss / headroom remain
[E12.2](e12-resilience-capacity.md).

**Accessibility review — Chloe / E12.3** (not this document).
**Operator UI guide — Chloe / E12.3** (not this document).

## Scope

Reviewers sign off that the following are documented, tested, and not
regressed before production enablement. Affected features stay disabled
until they can meet the security model (epic #181 acceptance).

| Area | What exists | Do not invent |
| --- | --- | --- |
| Trust boundaries | Six-row table in the security model | New boundaries or “trusted host” shortcuts |
| Embed | E11 + ADV-004…024 on `main` | New assertion transport or unpartitioned cookies |
| Credentials | Envelope vault, KEK, redaction, no plaintext in YAML/API/logs | Client-side decrypt or shared KEK in the UI |
| SSRF | ADV-010 default-deny after resolve; IPv6 IMDS always denied | Broad `allowPrivateDestinations` as a default |
| Tenancy | Server-derived workspace + FORCE RLS | Host-supplied workspace UUID as authorization |

## Trust boundaries (review)

Confirm each row still matches [security-model.md](security-model.md#trust-boundaries)
and has an E12.1 (or E12.2 fencing) proof:

| Boundary | Existing control | Primary proof |
| --- | --- | --- |
| Browser / embed host → API | Authenticate every request; authorize the resource in FlowForge; do not trust host route/tenant/workbench as authz | E12.1 domain 1 (session/embed) + domain 3 (isolation) |
| Host backend → embed exchange | Validate iss/aud/sig/`nbf`/`exp`/`jti`/capabilities/workspace; reject replay | E12.1 domain 1; ADV-008 verify-before-lookup; ADV-009 atomic `jti` |
| Trigger source → control plane | Per-trigger secret, constant-time verify, body cap, rate, replay, no secret in URL | E12.1 domain 2 |
| Control plane → worker | Signed job ticket, lease/fence, re-authorize before provider | E12.1 domain 7; E12.2 domain 2 |
| Worker → provider | Short-lived scoped credentials; redact/size-limit output | E12.1 domains 5, 6, 8 |
| Worker → outbound HTTP | Resolve then deny loopback/private/ULA/CGNAT/link-local/metadata (incl. IPv6 IMDS `fd00:ec2::254`); re-check redirects | E12.1 domain 9; ADV-010 |

## Embed

Existing production-locked behavior (do not relax for go-live):

- Durable Ed25519 PKCS#8 `EMBED_SIGNING_KEY` — boot-fail in production
  without it (ADV-006 / ADV-022). No committed seed. Overlap keys require
  finite `overlapUntil` ≤ 4h (ADV-014).
- Issuers are a required allowlist; empty is `403`. Production issuers
  must be absolute `https://` (ADV-018; boot-fail + request `403`).
- Exchange verifies before workspace lookup (ADV-008). Replay is `409`.
  Used `jti` retained 24h past `exp`.
- `nbf` leeway default 30s, hard max 60s; `exp` is exact (ADV-017).
- Signed `host=iss` + `ctx=embed|portal` select the path allowlist —
  not a client header (ADV-023).
- Embed cookies are CHIPS (`SameSite=None; Secure; Partitioned`).
  `Secure` is never dropped (ADV-007).
- Workspace delete revokes bound embed sessions (ADV-019).
- Chrome after exchange comes from `GET /session` `session.embed`
  (ADV-021), not host query.
- Catalog hides membership/isolation unless granted (ADV-024).
- Rate limits on mint/exchange (ADV-012). Audit is secret-free.
- Embed sessions cannot bootstrap tenants/workspaces. Portal `admin`
  never includes `platform.administer`.

## Credentials and secrets

- Accepted only over TLS; encrypted before persist (`CREDENTIAL_KEK` /
  file). Plaintext never returned in API, YAML, logs, artifacts, or audit.
- Worker use is a scoped handle; disablement/rotation take effect before
  the next step (E12.1 domain 5).
- Artifacts: short-lived download grants; legal hold; purge removes
  metadata and object bytes ([retention and backup](../operations/retention-backup.md)).
- `JOB_BINDING_SECRET` / `SCRIPT_SIGNING_KEY` must be durable in
  production (ephemeral process keys die on restart).
- Metrics and OpenAPI require `platform.administer` (ADV-020). Health
  and readiness stay unauthenticated for probes.

## SSRF

Default-deny after DNS resolve for `http.request` / webhook destinations.
Private destinations require an explicit connection flag or a
`kind=http` / `kind=notification` policy opt-in
(`allowPrivateDestinations`). Other policy kinds are ignored. Fail
closed when unset. Problem details must not echo resolved private IPs.
IPv6 IMDS remains denied even when private destinations are allowed
(ADV-010). Proof: E12.1 domain 9.

## Tenancy

- Workspace is the isolation boundary. Every workspace-owned query,
  cache key, queue payload, and audit row carries the **server-derived**
  `workspace_id`.
- FORCE RLS + `flowforge_app` `NOSUPERUSER` / `NOBYPASSRLS`. Unset or
  stale pool scope matches no rows.
- Host-supplied `id` / `workspace_id` on writes is `400`. Cross-workspace
  UUIDs are `404` (not a leak).
- Proof: E12.1 domain 3 (API + `TestPostgresRLSUnsetStaleAndCrossWorkspace`).

## Production-gate checklist

Sign off only when each box is true. Link evidence; do not restate
pass/fail by hand-editing JSON.

| # | Gate | Evidence |
| --- | --- | --- |
| 1 | E12.1 named suite green on `main` (all 10 domains) | [e12-security-verification.md](e12-security-verification.md), [last-run.json](e12-security-evidence/last-run.json), CI `.github/workflows/e12-security.yml` |
| 2 | Sibling supply-chain provenance / vuln gates green | `.github/workflows/supply-chain.yml` (`govulncheck`, `image-scan`, approved bases). Policy: [deploy/supply-chain/policy.md](../../deploy/supply-chain/policy.md) |
| 3 | E12.2 fail-closed suite green; every required headroom ratio ≥ 2.0 | [e12-resilience-capacity.md](e12-resilience-capacity.md), [capacity-last-run.json](e12-resilience-evidence/capacity-last-run.json) |
| 4 | Encrypted restore rehearsed (schema + compose/API boot) | `scripts/backup/restore-rehearsal.sh`, `restore-schema-rehearsal.sh`; [retention and backup](../operations/retention-backup.md) |
| 5 | Production config does not copy local pitfalls | [deployment](../deployment.md#production-vs-local-pitfalls): no `TRUSTED_DEV_IDENTITY_HEADERS` / `SEED_LOCAL_DEFAULTS`, digest-pinned images, TLS at ingress, `PLATFORM_ADMINS` set, durable KEK / embed key / job + script signing keys, https issuers |
| 6 | ADV hardenings on `main` still in force | ADV-002 (fail-closed identity), 004–014, 017–024 as listed above and in the security model. Do not revert for launch. |
| 7 | Threat-model areas above reviewed against the security model | This page + security-model trust table |
| 8 | Operator/admin **UI** guides published | **Chloe / E12.3** — stub: [operations/index.md](../operations/index.md#chloe-e123-placeholders) |
| 9 | Accessibility review complete | **Chloe / E12.3** — not claimed here |

Until 1–7 pass, production enablement is blocked by the security model
(feature stays disabled). 8–9 are Chloe's slice of #184; keep the issue
open until she lands.

## Ownership

- **jonny:** this review, API/OpenAPI, deploy/ops runbooks.
- **Chloe:** operator/admin UI guides + accessibility review. No UI
  screenshots or a11y claims in this PR.
