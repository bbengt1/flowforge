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
  cookies (`ff_session` is `HttpOnly` + `SameSite=Lax`; `ff_csrf` is readable +
  `SameSite=Strict`; both `Path=/api/v1`). State-changing browser requests
  require CSRF protection (`X-CSRF-Token` paired with `ff_csrf` and the
  server-side hash). Bearer tokens are never accepted from a URL or persisted
  in browser local storage. Idle and absolute expiry fail closed.
- Embed assertions are asymmetric-key signed, short-lived, single-use, and
  audience-bound to FlowForge (`aud=flowforge`, Ed25519 / EdDSA, `jti`).
  Exchange validates issuer (optional allowlist), audience, `nbf`/`exp`, `jti`,
  capabilities, and workspace binding. Token IDs are consumed atomically with
  TTL (replay is conflict). Key rotation accepts only active and explicitly
  overlapping verification keys; unknown `kid` fails closed. The rotate API
  may register only the previous active public key and requires
  `platform.administer` (`PLATFORM_ADMINS`); `workspace.administer` is not
  enough.   After exchange, the
  browser session is bound to `(tenant_id, workbench_key)`; that pair travels
  through API authorization, configuration lookups, jobs/workers, caches,
  realtime, history, and audit. The bound session cannot call tenant or
  workspace create (fail closed). A host-supplied tenant is never authorization.
  The UI treats host-provided identity as display context until
  `POST /embed/exchange` verifies it. The CP Ops Portal adapter mints those
  same assertions after Portal RBAC; Portal entry is never FlowForge
  authorization, and FlowForge does not share its database or executor.
  After exchange, embed chrome and deep
  links use the FlowForge-verified `(tenant_id, workbench_key)` /
  `session.embed` only. Assertions are never accepted from a URL. See
  [embed SDK](embed-sdk.md).
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
  approval expiry; and provider credential revocation.

## Incident-safe behavior

On authorization, signature, policy, artifact-verification, or redaction failure,
fail closed before a provider call. On uncertain provider outcome or lease loss,
mark the step `indeterminate`, retain safe evidence, and require verification or
an explicitly authorized recovery action. Never infer that a side effect did not
occur.
