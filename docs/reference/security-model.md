# Security model

This document is the implementation gate for FlowForge's control plane, workers,
and embedded surface. It defines security requirements, not optional deployment
hardening. A feature that cannot meet these requirements is disabled until it can.

## Trust boundaries

| Boundary | Trust decision | Required control |
| --- | --- | --- |
| Browser or embedded host → API | Caller may be forged, stale, or from another workspace. | Authenticate every request; authorize the requested resource in FlowForge; do not trust host route, tenant, or workbench values. |
| Host backend → embed exchange | A host session is not a FlowForge session. | Validate issuer, audience, signature, expiry, `nbf`, subject, and a unique token ID; bind the assertion to the requested workspace and capabilities; reject replayed assertions. |
| Trigger source → control plane | A caller may replay, flood, or guess a trigger URL. | Use per-trigger secrets, constant-time verification, bounded body size, rate limits, replay protection, and an idempotency key. Never put a secret in a URL. |
| Control plane → worker | Queue data is untrusted transport data. | Sign or authenticate jobs; include workspace, workflow-version digest, policy revision, expiration, lease/fencing data, and correlation ID; re-authorize before execution. |
| Worker → provider | Provider credentials and responses are sensitive. | Resolve short-lived scoped credentials only in the worker; enforce target policy; redact and size-limit output before it crosses back to the control plane. |
| Worker → outbound HTTP | `http.request` / webhook destinations may be attacker-controlled after DNS. | Resolve, then deny loopback, RFC1918/ULA, CGNAT, link-local, and metadata by default; re-check every redirect hop. Private destinations require an explicit connection or workspace-policy opt-in (`allowPrivateDestinations`). Fail closed when unset. Problem details must not echo resolved private IPs. |

## Identity, sessions, and authorization

- Authentication establishes a subject. Authorization then evaluates the action,
  workspace, resource, workflow version, target, and current policy. A valid
  session alone never authorizes a run, credential use, approval, or export.
- Production identity is fail-closed. Client-supplied `X-FlowForge-Issuer` /
  `X-FlowForge-Subject` (and a matching `POST /session` body) are **not**
  authentication and must not upsert principals. Prefer the cookie session
  issued by `POST /embed/exchange` (or a future OIDC login). Self-asserted
  header identity is enabled only by the explicit, non-default
  `TRUSTED_DEV_IDENTITY_HEADERS` flag together with
  `APP_ENV=development|dev|local|test`. Empty or missing config denies
  header identity. The process refuses to start if the flag is set in
  production (`APP_ENV` empty/production) or when `REQUIRE_TLS=true`, so
  it cannot stay on accidentally. See [deployment](../deployment.md).
- Tenant and workspace bootstrap (`POST /tenants`, `POST /workspaces`)
  requires `platform.administer` via `PLATFORM_ADMINS` (`issuer|subject`)
  on a **non-embed** session (or trusted-dev header identity).
  Unauthenticated callers are `401`; any other caller is `403`. Empty
  `PLATFORM_ADMINS` is fail-closed. Workspace `admin` is not enough.
- Metrics and OpenAPI/swagger (`GET /api/v1/metrics`, `/openapi.yaml`,
  `/openapi.json`, `/swagger`) require the same `platform.administer`
  allowlist on an authenticated principal. Unauthenticated is `401`;
  any other caller (including empty `PLATFORM_ADMINS`) is `403`. There
  is no anonymous scrape token and no workspace-assignable
  `ops.metrics.read`. Scrapers send `Authorization: Bearer` with the
  opaque `ff_session` token, or the `ff_session` cookie. Trusted-dev
  identity headers work only when that flag is on. Health and
  readiness (`GET /api/v1/health`, `GET /api/v1/readiness`) stay
  unauthenticated so Kubernetes probes keep working.
  After `POST /embed/exchange`, the session is bound to the assertion’s
  `(tenant_id, workbench_key)` (and mapped workspace). Embed-origin
  sessions cannot create tenants, workspaces, or sibling workbenches —
  including when the principal is a platform-admin or the assertion
  carried Portal `admin` capabilities. Response is `403` with a problem
  detail that embed sessions cannot create tenants or workspaces.
  Portal-minted `admin` / elevated capabilities never include
  `platform.administer` and never bootstrap FlowForge membership.
- Authorization is deny-by-default. Every workspace-owned query, cache key,
  queue payload, realtime subscription, artifact URL, and audit event carries the
  server-derived workspace ID. Database RLS is a backstop, not the only check.
- Browser sessions use `Secure`, `HttpOnly`, and appropriately scoped `SameSite`
  cookies. Top-level / non-embed sessions keep the safer default:
  `ff_session` is `HttpOnly` + `SameSite=Lax`; `ff_csrf` is readable +
  `SameSite=Strict`; both `Path=/api/v1` and `Secure` on HTTPS. Embed
  sessions issued by `POST /embed/exchange` (and later refresh of that
  bound session) use **CHIPS** so they work in a cross-site iframe
  without weakening first-party cookies: `SameSite=None; Secure;
  Partitioned` on both `ff_session` and `ff_csrf`. `Secure` is never
  dropped. `SameSite=None` is never used without `Partitioned`. Do not
  fall back to unpartitioned `SameSite=None` or to `Lax`/`None` without
  `Secure`. Browsers must be a secure context (HTTPS) and support
  partitioned cookies; if the cookie is not stored or not sent, later
  calls fail closed (`401` unauthenticated, or `403` CSRF on mutations).
  State-changing browser requests require CSRF protection
  (`X-CSRF-Token` paired with `ff_csrf` and the server-side hash).
  Bearer tokens are never accepted from a URL or persisted in browser
  local storage. Idle and absolute expiry fail closed. Deleting a
  workspace (`DELETE /workspace`, soft-disable `status=disabled`, or a
  hard `DELETE` of the workspace row) revokes every embed session bound
  to that workspace_id or `(tenant_id, workbench_key)`, including CHIPS
  cookies from `POST /embed/exchange`. Later requests with those
  cookies are `401`. Unbound standalone sessions and sessions bound to
  other workspaces are not revoked. Revoke runs before disable; if
  revoke cannot complete, the workspace is not deleted (fail closed).
  PostgreSQL applies the same revoke in the disable/delete transaction
  via trigger so a raw SQL path cannot leave a live embed session.
- Embed assertions are asymmetric-key signed, short-lived, single-use, and
  audience-bound to FlowForge (`aud=flowforge`, Ed25519 / EdDSA, `jti`).
  Exchange validates issuer against a required allowlist (`EMBED_ISSUER` /
  `EMBED_ISSUER_ALLOWLIST` merged with `PORTAL_ISSUER` /
  `PORTAL_ISSUER_ALLOWLIST`), audience, `nbf`/`exp`, `jti`,
  capabilities, and workspace binding. `nbf` clock-skew is a short
  documented leeway (default 30s, `EMBED_NBF_LEEWAY`, hard max 60s);
  `exp` is exact. An empty allowlist fails closed
  at request time (`403` on mint and exchange) — the process does not
  refuse to start, consistent with empty `PLATFORM_ADMINS`. Production
  (empty/`production` `APP_ENV` or `REQUIRE_TLS`) requires every
  configured issuer to be an absolute `https://` URI: a non-https
  allowlist entry is a boot-fail, and mint/exchange still reject a
  non-https `iss` with `403` (ADV-018). Local/dev/test may use `http://`
  issuers. Token IDs
  are consumed atomically in one
  `INSERT … ON CONFLICT DO NOTHING RETURNING` and retained 24h past
  JWT `exp` (replay is conflict). The active signing key is durable
  (`EMBED_SIGNING_KEY` / file). Production (empty/`production` `APP_ENV` or
  `REQUIRE_TLS`) **refuses to start** without it — no boot-only ephemeral
  key. An ephemeral process key is gated to explicit non-production
  `APP_ENV` only and is minted with `crypto/rand` (no committed seed).
  Key rotation accepts only active and explicitly
  overlapping verification keys. Every overlap key requires a short
  finite `overlapUntil` (max 4h). Missing, zero, or far-future expiry
  is refused — it is not treated as forever. The active signing key is
  not an overlap key and does not use `overlapUntil`. Unknown, missing-expiry,
  expired, or far-future `kid` fails closed. Exchange and JWKS refresh the
  overlap set from the durable store so stale in-memory rings cannot keep
  accepting retired keys or miss overlap registered on another instance.
  The rotate API may register only the previous active public key, requires
  `overlapUntil` (max 4h), and requires `platform.administer`
  (`PLATFORM_ADMINS`); `workspace.administer` is not enough. Bad
  `EMBED_OVERLAP_KEYS` is a boot-fail. Mint binds `sub` and `iss` to the authenticated caller. A
  different subject requires `embed.impersonate` (same `PLATFORM_ADMINS`
  allowlist; empty is fail-closed). A different issuer is always `403`.
  Workspace `admin` cannot impersonate. `embed.impersonate` is
  platform-scoped and is never mintable. After exchange, the
  browser session is bound to `(tenant_id, workbench_key)`; that pair travels
  through API authorization, configuration lookups, jobs/workers, caches,
  realtime, history, and audit. The bound session cannot call tenant or
  workspace create (fail closed). A host-supplied tenant is never authorization.
  The UI treats host-provided identity as display context until
  `POST /embed/exchange` verifies it. Exchange also binds assertion
  `iss` to the minting host issuer (`X-FlowForge-Host-Issuer` /
  `hostContext`); an assertion minted under issuer A cannot be
  exchanged when the host expects issuer B. The CP Ops Portal adapter mints those
  same assertions after Portal RBAC; Portal entry is never FlowForge
  authorization, and FlowForge does not share its database or executor.
  After exchange, embed chrome and deep
  links use the FlowForge-verified `(tenant_id, workbench_key)` /
  `session.embed` only. Assertions are never accepted from a URL.
  Embed authorization decisions (mint, exchange, rotate, capability
  and tenancy bind, impersonation) emit secret-free audit events;
  assertion plaintext, signing keys, and session secrets are never
  logged. `POST /embed/exchange` is rate-limited by IP and
  issuer/subject (defaults 120/min and 30/min, configurable) and
  returns `429` on burst so forged assertions cannot exhaust verify
  or `jti` store capacity. See [embed SDK](embed-sdk.md).
- Privileged actions and approval decisions require fresh authorization at the
  server. Approval records bind the exact execution step, workflow version,
  target/policy snapshot, requested operation, and expiry; a decision cannot be
  reused after any of those change.

## Trigger safety

Manual, webhook, and schedule triggers are distinct entry points and must all
produce an auditable, version-pinned execution.

- Webhook triggers have an opaque generated ID and an independently rotatable
  secret. Verify a versioned signature over the exact raw body and timestamp
  before parsing it. Reject absent, invalid, expired, or replayed signatures;
  cap clock skew and retain replay identifiers for at least that skew window.
- Apply per-trigger and per-workspace rate/concurrency limits before enqueueing.
  Enforce a documented maximum request body and reject unsupported content types.
  Parse payloads with resource limits and map only allowlisted fields into typed
  trigger input; never interpret payload text as YAML, shell, template, or code.
- Schedules are server-owned, timezone-explicit, and bounded. Misfire policy,
  maximum catch-up runs, and overlap behavior are explicit; the safe default is
  no catch-up and one active execution per schedule unless the workflow is
  verified idempotent.
- The execution idempotency key is scoped to workspace and immutable workflow
  version, has a bounded retention period, and stores a fingerprint of the
  authenticated caller/trigger and normalized request. The same key with a
  different fingerprint fails rather than joining unrelated work.

## Secret, artifact, and output handling

- Credentials are accepted only over TLS, encrypted before persistence, and
  retrieved through a scoped, short-lived worker handle. Rotation, disablement,
  and expiry take effect before each execution step. Never expose plaintext in
  YAML, API responses, browser state, job payloads, artifacts, metrics, traces,
  or audit records.
- Redaction occurs before persistence and before display, export, notification,
  or cross-node transfer. It is defense in depth: output ports have an explicit
  schema, content type, and size limit, and unbounded stdout/stderr or provider
  responses are stored only as access-controlled, encrypted artifacts after
  redaction.
- Artifact access is workspace-authorized on every request. Use short-lived,
  single-resource download grants; do not return bucket credentials or durable
  public URLs. Retention deletion must remove both metadata and object data, with
  auditable legal-hold exceptions. E5.3 implements this on the Go API
  (`POST /artifacts/{id}/downloads` + `GET /artifact-downloads/{grantId}`,
  `POST /retention/purge`, `POST /artifacts/{id}/legal-hold`).
- Script and connector artifacts require a verified signature, digest pin, scan
  status, approved runtime profile, and provenance before dispatch. Revocation
  blocks new runs; an already-running execution is handled according to an
  explicit emergency-stop policy.

## Operational controls and verification

- TLS is required at every network boundary. Production configuration must set
  secure headers, an explicit CSP appropriate to the embed mode, clickjacking
  protection, and restrictive CORS origins (`CORS_ALLOWED_ORIGINS` exact
  allowlist; foreign origins fail closed); wildcard credentialed CORS is
  prohibited.
- Log correlation IDs, actor/resource identifiers, decisions, and outcomes, but
  never authorization headers, cookie values, credential material, webhook
  bodies, or unredacted provider output. Protect audit records from normal
  application mutation (`flowforge_app` cannot UPDATE or DELETE `audit_events`)
  and emit operational alerts on failed authorization, replay, policy, and
  redaction. Alert payloads carry correlation/resource identifiers only.
- Enforce dependency/image provenance, vulnerability scanning, patching SLAs,
  secret rotation, backup encryption, restore testing, and least-privilege
  service identities before production use.
- Security tests cover cross-workspace reads/writes and subscriptions; assertion
  validation and replay; CSRF/CORS; webhook signature, replay, rate, and body
  limits; output/artifact authorization and redaction; stale worker fencing;
  approval expiry; provider credential revocation; and outbound HTTP SSRF
  (loopback/private/metadata denial after resolve, DNS rebinding, and
  redirect-to-private).

## Incident-safe behavior

On authorization, signature, policy, artifact-verification, or redaction failure,
fail closed before a provider call. On uncertain provider outcome or lease loss,
mark the step `indeterminate`, retain safe evidence, and require verification or
an explicitly authorized recovery action. Never infer that a side effect did not
occur.
