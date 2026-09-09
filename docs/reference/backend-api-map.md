# Backend API map

## Foundation routes

| Route | Purpose | Success | Failure |
| --- | --- | --- | --- |
| `GET /api/v1/health` | Process liveness; no dependency check. | `200 {"status":"ok"}` | — |
| `GET /api/v1/readiness` | PostgreSQL dependency readiness. | `200 {"status":"ready"}` | `503` RFC 9457 Problem Details (`dependency-unavailable`) |
| `GET /api/v1/metrics` | Baseline Prometheus text metrics (request count and duration). | `200` `text/plain` | — |
| `GET /api/v1/openapi.yaml` | Published OpenAPI YAML. | `200` | — |
| `GET /api/v1/openapi.json` | Published OpenAPI JSON. | `200` | — |
| `GET /api/v1/swagger` | Specification landing page. | `200` | — |

## Browser sessions (E2.3)

Browser clients use cookie sessions. Non-browser callers (tests, hooks, Next.js server proxies that still inject headers) may keep `X-FlowForge-Issuer` / `X-FlowForge-Subject`. When `ff_session` is present, identity comes only from the session; conflicting identity headers fail closed (`403`). Header-only callers skip CSRF.

**UI route map (Chloe):** call the API origin with `credentials: "include"`. Do not store the session token or CSRF secret in `localStorage`. Read `csrf_token` from the JSON body (or the `ff_csrf` cookie) and send it as `X-CSRF-Token` on every state-changing request.

| Cookie | Flags | Purpose |
| --- | --- | --- |
| `ff_session` | `HttpOnly`, `SameSite=Lax`, `Secure` on HTTPS, `Path=/api/v1` | Opaque session id (server stores SHA-256 only) |
| `ff_csrf` | readable, `SameSite=Strict`, `Secure` on HTTPS, `Path=/api/v1` | Double-submit CSRF pair with `X-CSRF-Token` |

Idle default **30m**, absolute default **12h** (`SESSION_IDLE_TIMEOUT` / `SESSION_ABSOLUTE_TIMEOUT`). Refresh extends idle only; it cannot pass the absolute cap. Stale, revoked, or forged cookies are `401`.

CORS is an exact allowlist (`CORS_ALLOWED_ORIGINS`). Empty allowlist + foreign `Origin` is `403` with no `Access-Control-Allow-Origin`. Wildcard / `null` origins are rejected at process start. Same-origin and Origin-less callers are allowed. CSP remains `default-src 'none'` (plus `frame-ancestors` / `form-action` / `object-src` none).

| Route | Purpose | Success | Failure |
| --- | --- | --- | --- |
| `POST /api/v1/session` | Create session from identity headers and/or JSON `{issuer,external_subject,display_name?}`. Headers win; a conflicting body is `403`. Sets both cookies. | `201` `{session,principal,csrf_token}` | `401` `403` (hostile origin or identity conflict) |
| `GET /api/v1/session` | Current browser session. Cookie required; header-only is `401`. | `200` `{session,principal,csrf_token}` | `401` `403` |
| `POST /api/v1/session/refresh` | Extend idle expiry; rotate CSRF. Requires CSRF pair. Concurrent/stale CSRF is `409`. | `200` `{session,principal,csrf_token}` | `401` `403` `409` |
| `POST /api/v1/session/logout` | Revoke session and clear cookies. Requires CSRF when a session cookie is present. | `204` | `403` |
| `GET /api/v1/session/audit-events` | Caller's secret-free session audit events. | `200` `{items}` | `401` |

Session audit event types: `session.created`, `session.refreshed`, `session.revoked`, `session.expired`, `session.csrf_rejected`, `session.origin_rejected`, `session.privilege_denied`, `session.auth_rejected`. Logs and audit rows never include cookie or token values.

## Workspace identity and RBAC (E2.1)

Identity headers establish the subject for non-browser callers: `X-FlowForge-Issuer` and `X-FlowForge-Subject` (optional `X-FlowForge-Display-Name`). Browser clients should use E2.3 sessions instead. Headers do not authorize a workspace. The UI session adapter is `apps/web/src/lib/session-contract.ts`.

Workspace identity is resolved only from `X-FlowForge-Tenant-ID` or `X-FlowForge-Tenant-Slug` plus `X-FlowForge-Workbench-Key`. `X-FlowForge-Workspace-ID` is untrusted host context: it is rejected when it is the only identity, and forbidden when it does not match the server-derived workspace.

| Route | Purpose | Success | Failure |
| --- | --- | --- | --- |
| `GET /api/v1/permission-matrix` | Role/permission catalog covering view, edit, publish, execute, credential, approval, and administration. | `200` `{permissions,roles}` | `401` |
| `GET /api/v1/roles` | Persisted role vocabulary. | `200` `{items}` | `401` |
| `GET /api/v1/permissions` | Persisted permission vocabulary. | `200` `{items}` | `401` |
| `POST /api/v1/tenants` | Create a tenant. Any identified subject may bootstrap a tenant in this slice. | `201` tenant | `400` `401` `409` |
| `GET /api/v1/workspaces` | Workspaces the caller belongs to (server-side bindings). | `200` `{items}` | `401` |
| `POST /api/v1/workspaces` | Create a workspace unique on `(tenant_id, workbench_key)`; caller is bound as `admin`. Body `id` / `workspace_id` rejected. | `201` workspace | `400` `401` `404` `409` |
| `GET /api/v1/workspace` | Current workspace, roles, and permissions after membership check. | `200` | `400` `401` `403` `404` |
| `GET /api/v1/workspace/members` | List members. Requires `workspace.administer`. | `200` `{items}` | `401` `403` |
| `PUT /api/v1/workspace/members` | Replace a member's roles (`user_id` or issuer+subject). Requires `workspace.administer`. | `200` member | `400` `401` `403` `404` `409` |
| `DELETE /api/v1/workspace/members/{userID}` | Remove a member. Cannot remove the last administrator. | `204` | `401` `403` `404` `409` |

## Workspace isolation (E2.2)

After membership authorization, the API sets transaction-local `app.workspace_id` and queries workspace-owned tables under `FORCE ROW LEVEL SECURITY`. Host-supplied `id` / `workspace_id` on write bodies is rejected. A valid UUID from another workspace is `not-found` (not a leak). These routes are isolation hooks for surfaces that exist today; later credential/artifact/execution epics keep the same scope rules.

| Route | Purpose | Success | Failure |
| --- | --- | --- | --- |
| `GET /api/v1/workspace/records?kind=` | List scoped records. `kind` required. Permission depends on kind. | `200` `{items}` | `400` `401` `403` |
| `POST /api/v1/workspace/records` | Create a scoped record (`credential`, `artifact`, `job`, `cache`, `realtime`, `audit`). | `201` record | `400` `401` `403` |
| `GET /api/v1/workspace/records/{id}` | Get a scoped record. | `200` | `401` `403` `404` |
| `POST /api/v1/workspace/records/{id}/links` | Attach a child via composite `(workspace_id, parent_id)` FK. | `201` link | `400` `401` `403` `404` |
| `POST /api/v1/workspace/credentials/{id}/use` | E2.2 isolation hook use (stub record). Requires `credential.use`. Product vault use is `POST /credentials/{id}/use`. | `204` | `401` `403` `404` |
| `GET /api/v1/workspace/artifacts/{id}` | E2.2 isolation hook (stub record). Product artifacts are `GET /artifacts/{id}` (E5.3). Requires `execution.view`. | `200` | `401` `403` `404` |
| `GET /api/v1/workspace/jobs` | List job hooks. Requires `execution.view`. | `200` `{items}` | `401` `403` |
| `POST /api/v1/workspace/jobs` | Enqueue a job hook. Requires `workflow.execute`. | `201` | `401` `403` |
| `GET /api/v1/workspace/cache/{key}` | Workspace-prefixed cache read. | `200` | `401` `403` `404` |
| `PUT /api/v1/workspace/cache/{key}` | Workspace-prefixed cache write. | `200` | `401` `403` |
| `POST /api/v1/workspace/realtime/channels/{id}/subscribe` | Realtime subscribe. Requires `workflow.view`. | `200` | `401` `403` `404` |
| `GET /api/v1/workspace/audit-events` | List audit hooks. Requires `workspace.administer`. | `200` `{items}` | `401` `403` |

E2.2 `kind=credential` records are isolation stubs without encryption. The product vault is `/api/v1/credentials` below.

## Encrypted credential vault (E4.1)

Workspace-scoped envelope-encrypted secrets. Plaintext is accepted only on create/rotate over TLS, encrypted before persistence, and is **never** returned in JSON, problem details, logs, metrics, YAML, jobs, or audit `details`. Isolation hook `POST /workspace/credentials/{id}/use` stays for E2.2 stubs; product use is `POST /credentials/{id}/use` (`204`, empty body).

**Key source (no hard-coded secrets):** `CREDENTIAL_KEK` (32-byte AES-256 as standard/raw-URL base64 or 64 hex chars) or `CREDENTIAL_KEK_FILE`. Optional `CREDENTIAL_KEK_ID` is stored as `keyReference` (default `env:CREDENTIAL_KEK` / `file:CREDENTIAL_KEK_FILE`). Missing/invalid KEK fails closed on create/rotate/test/use (`503` `dependency-unavailable`). Local MVP envelope: random DEK + AES-256-GCM payload, DEK wrapped with the KEK. Production should wrap the KEK with a KMS and keep loading the unwrapped key from env.

**UI route map (Chloe):** cookie session + `credentials: "include"`; send `X-CSRF-Token` on POST/PATCH/DELETE. JSON is camelCase. Never persist `secret` in `sessionStorage`, `localStorage`, URLs, or analytics. After submit, drop the form values. List/detail/events show only metadata (`displayName`, `type`, `status`, `tags`, `fingerprint`, test/rotation timestamps, `permittedActions`). Host-supplied `id` / `workspace_id` / `workspaceId` on write bodies is `400`. Cross-workspace UUIDs are `404`. Do not rewrite `apps/web` in this API story.

Suggested UI flow:

1. `GET /credentials/catalog` for type + field shapes (names only).
2. Add wizard: `POST /credentials` `{type,displayName,tags?,metadata?,expiresAt?,secret}`. Keep `id`; discard `secret`.
3. List: `GET /credentials`. Detail: `GET /credentials/{id}`.
4. Metadata edit: `PATCH /credentials/{id}` (sending `secret` is `400`).
5. Rotate: `POST /credentials/{id}/rotate` `{secret}`.
6. Test: `POST /credentials/{id}/test` → `{result:{status,reason,checkedAt},credential}` (no plaintext).
7. Disable/enable: `POST .../disable` / `.../enable`.
8. Usage: `GET .../usage`. Before delete: `GET .../deletion-impact`. Delete only with `{confirm:true}`; `409` while an active execution references the id.
9. Audit: `GET .../events`.

RBAC: `credential.view` list/get/usage/impact/events/catalog; `credential.use` test+use (operator); `credential.manage` create/rotate/disable/enable/delete/patch (admin). Viewer has no credential permissions. Editor/publisher can view metadata only.

| Route | Purpose | Success | Failure |
| --- | --- | --- | --- |
| `GET /api/v1/credentials/catalog` | Typed field catalog (no values). Requires `credential.view`. | `200` `{types}` | `401` `403` |
| `GET /api/v1/credentials` | List metadata. | `200` `{items}` | `401` `403` |
| `POST /api/v1/credentials` | Create; encrypt `secret` before persist. | `201` metadata | `400` `401` `403` `503` |
| `GET /api/v1/credentials/{credentialId}` | Metadata only. | `200` | `401` `403` `404` |
| `PATCH /api/v1/credentials/{credentialId}` | Safe metadata (`displayName`, `tags`, `metadata`, `expiresAt`). | `200` | `400` (incl. `secret`) `401` `403` `404` |
| `POST /api/v1/credentials/{credentialId}/rotate` | Replace encrypted payload. | `200` metadata | `400` `401` `403` `404` `503` |
| `POST /api/v1/credentials/{credentialId}/disable` | Disable; use fails closed. | `200` | `401` `403` `404` |
| `POST /api/v1/credentials/{credentialId}/enable` | Re-enable. | `200` | `401` `403` `404` |
| `POST /api/v1/credentials/{credentialId}/test` | In-process shape check. Requires `credential.use` or `manage`. | `200` `{result,credential}` | `401` `403` `404` |
| `POST /api/v1/credentials/{credentialId}/use` | Record use; empty body. Requires `credential.use`. | `204` | `401` `403` `404` `409` (disabled/expired) |
| `GET /api/v1/credentials/{credentialId}/usage` | Last-used + draft/version/execution refs. | `200` | `401` `403` `404` |
| `GET /api/v1/credentials/{credentialId}/deletion-impact` | Affected drafts/versions/active executions. | `200` `{canDelete,...}` | `401` `403` `404` |
| `DELETE /api/v1/credentials/{credentialId}` | Delete after `{confirm:true}`. | `204` | `400` `401` `403` `404` `409` |
| `GET /api/v1/credentials/{credentialId}/events` | Redacted vault audit. | `200` `{items}` | `401` `403` `404` |

## Versioned operational configuration (E4.2)

Workspace-scoped cluster/SSH targets, command/runtime profiles, connections, recipient lists, message templates, response schemas, and policies. Each resource has one mutable draft and immutable published revisions. Workflow publish and execution start **pin exact versions**; later draft edits do not retarget a pin. Endpoint, recipient, template, and schema selection is server-authorized: the client sends resource UUIDs only; the API resolves a published revision in the current workspace. Cross-workspace UUIDs are `404`. Host-supplied `id` / `workspace_id` / `workspaceId` on write bodies is `400`.

Physical tables: `ops_resources`, `ops_resource_drafts`, `ops_resource_versions` (immutable), `ops_pins` (immutable), `target_policy_bindings`. FORCE RLS + composite `(workspace_id, id)` FKs. Credential references use composite FK to `credentials`. Policy evaluation and approval binding are E4.3 below.

**UI route map (Chloe):** do **not** stack on another feature branch. These paths are stable on `main`. Cookie session + `credentials: "include"`; send `X-CSRF-Token` on POST/PUT. JSON is camelCase. Next proxies can rewrite `/api/control-plane/{collection}/...` the same way as credentials/workflows. Suggested screens: `/targets`, `/profiles`, `/connections`, `/templates` (or one `/ops-config?kind=`). Do not rewrite `apps/web` in this API story.

Suggested UI flow:

1. `GET /ops-config/catalog` for kinds, URL collections, YAML field names, `usePermission`, (E7.1) `kubernetesEngine`, and (E8.1) `sshEngine`. Cluster-target rows include `allowedCredentialTypes: ["kubernetes"]`. SSH-target rows include `allowedCredentialTypes: ["ssh_private_key"]`.
2. List: `GET /{collection}` (`cluster-targets`, `ssh-targets`, `command-profiles`, `runtime-profiles`, `connections`, `recipient-lists`, `message-templates`, `response-schemas`, `policies`).
3. Create draft: `POST /{collection}` `{name, slug?, spec}`. Keep `resource.id` and `draft.revision`.
4. Save: `PUT /{collection}/{id}/draft` `{revision, spec, name?}`. On `409`, reload the draft.
5. Publish: `POST /{collection}/{id}/publish` `{revision?, note?}` (`opsconfig.publish`).
6. History: `GET /{collection}/{id}/versions` and `GET .../versions/{versionId}`.
7. Picker / authorize: `POST /{collection}/{id}/select` `{versionId?}` or batch `POST /ops-config/select` `{refs:[{kind,resourceId,versionId?}]}`. Drafts cannot be selected (`400`).
8. Workflow YAML stores **resource** UUIDs (`clusterTargetId`, `sshTargetId`, `commandProfileId`, `runtimeProfileId`, `connectionId`, `recipientListId`, `templateId`, `responseSchemaRef`, `policyId`). The API pins versions at workflow publish / execution start. Read pins: `GET /workflows/{workflowId}/versions/{versionId}/pins` and `pins[]` on execution JSON.
9. Disable/enable: `POST /{collection}/{id}/disable` / `enable`. Disabled resources cannot be selected.

RBAC: `opsconfig.view` list/get/select snapshot; `opsconfig.edit` create/save/disable; `opsconfig.publish` publish; `opsconfig.use` plus `clusterTarget.use`, `sshTarget.use`, `commandProfile.use`, `runtimeProfile.use`, `connection.use`, `recipientList.use`, `messageTemplate.use`, `responseSchema.use`, `policy.use` are required to **execute** a workflow that pins those kinds (operator/admin). Viewer can read catalogs; editor can draft; publisher can publish revisions.

| Route | Purpose | Success | Failure |
| --- | --- | --- | --- |
| `GET /api/v1/ops-config/catalog` | Kinds, collections, YAML fields, plus `kubernetesEngine` (E7.1) and `sshEngine` (E8.1). Requires `opsconfig.view`. | `200` `{kinds,kubernetesEngine,sshEngine}` | `401` `403` |
| `GET /api/v1/kubernetes/catalog` | Engine allowlists, evaluation keys, service-account templates. Requires `opsconfig.view`. Does not contact a cluster. | `200` engine catalog | `401` `403` |
| `GET /api/v1/ssh/catalog` | Profile parameter types, reviewed render rules, retry-safe flags (schema only), publish rules, and error codes. Requires `opsconfig.view`. Does not open SSH. | `200` engine catalog | `401` `403` |
| `POST /api/v1/ops-config/select` | Batch server-authorized pins. | `200` `{items}` | `400` `401` `403` `404` |
| `GET /api/v1/{collection}` | List heads. | `200` `{items}` | `401` `403` |
| `POST /api/v1/{collection}` | Create draft revision 1. | `201` `{resource,draft}` | `400` `401` `403` `409` |
| `GET /api/v1/{collection}/{resourceId}` | Head + latest version pointers. | `200` | `401` `403` `404` |
| `GET /api/v1/{collection}/{resourceId}/draft` | Mutable spec. | `200` | `401` `403` `404` |
| `PUT /api/v1/{collection}/{resourceId}/draft` | Conflict-safe save. | `200` `{resource,draft}` | `400` `409` `401` `403` `404` |
| `POST /api/v1/{collection}/{resourceId}/publish` | Immutable revision. | `201` `{resource,version}` | `409` `401` `403` `404` |
| `GET /api/v1/{collection}/{resourceId}/versions` | History, newest first. | `200` `{items}` | `401` `403` `404` |
| `GET /api/v1/{collection}/{resourceId}/versions/{versionId}` | Frozen snapshot. | `200` | `401` `403` `404` |
| `POST /api/v1/{collection}/{resourceId}/select` | Pin latest or `{versionId}`. | `200` pin | `400` draft `404` `409` disabled |
| `POST /api/v1/{collection}/{resourceId}/disable` | Soft-disable. | `200` | `401` `403` `404` |
| `POST /api/v1/{collection}/{resourceId}/enable` | Re-enable. | `200` | `401` `403` `404` |
| `GET /api/v1/workflows/{workflowId}/versions/{versionId}/pins` | Pins bound at publish. | `200` `{items}` | `401` `403` `404` |

`spec` shapes (unknown fields rejected):

| Kind | Required `spec` |
| --- | --- |
| `cluster_target` | `credentialId` (workspace `kubernetes` / kubeconfig credential only), `endpoint.apiServer` or `tlsServerName`; optional `allowedNamespaces` (non-empty DNS-1123 labels), `policyId` (published `kind=kubernetes` policy; target namespaces must be a subset), `serviceAccount.{name,namespace?,roleTemplate?}` (`roleTemplate` defaults to `namespace-scoped-runner`; ClusterRoles are not MVP). Wrong credential type → `400`. Cross-workspace `credentialId` → `404`. Specs never include kubeconfig. |
| `ssh_target` | `credentialId` (workspace `ssh_private_key` credential only), `hostname`, `hostKeyFingerprint` (`sha256:<64 hex>` or OpenSSH `SHA256:<base64>`, canonicalized to `sha256:<hex>`); optional `port` (default 22), `allowedAddresses` (IP/CIDR; present empty list is rejected; no `0.0.0.0/0`), `policyId` (published `kind=ssh` policy). Wrong credential type → `400`. Cross-workspace `credentialId` → `404`. Specs never include `privateKey` / `passphrase` / kubeconfig. |
| `command_profile` | `parameterSchema` (restricted object schema: `string` / `integer` / `boolean` properties, `additionalProperties: false`), `template` (reviewed `{name}` placeholders only; no `$()`, `` ` ``, `${`, `{{`, `$`); optional `retrySafe` (schema flag; E8.3 implements retry semantics), `policyId` (published `kind=ssh` policy). The reviewed renderer owns POSIX single-quote substitution and rejects values outside the schema. |
| `runtime_profile` | `language` (`python`/`go`), `imageDigest`, `dependencyLockDigest`, `limits.{cpuMillis,memoryMib,timeoutSeconds,processes}` |
| `connection` | `type` (`http`/`webhook`/`smtp`), `endpointPolicy.{hosts,methods,pathPrefixes}`; optional `credentialId`, ports/TLS/redirects |
| `recipient_list` | `recipientPolicy.emails` and/or `domains` (allowlist only) |
| `message_template` | `inputSchema`, `contentClassification`, `body`; optional `subject` |
| `response_schema` | `schema`, `maxBytes` (1–1048576) |
| `policy` | `kind` (`kubernetes`/`ssh`/`script`/`http`/`notification`/`approval`), `policy` object. Evaluation keys (E4.3 / E7.1): `requireApproval`, `approverRole`, `expiresIn` (ISO-8601), `operations`, `deny`, `allowedNamespaces`/`namespaces`, `allowedKinds`/`kinds`, `allowedVerbs`/`verbs`, `allowedHosts`/`hosts`, `allowedAddresses`/`addresses`. For `kind=kubernetes`, unknown keys are rejected; aliases canonicalize to `allowedNamespaces` / `allowedKinds` / `allowedVerbs`. Empty allowlists are rejected (open-by-accident). Publish/select of a kubernetes policy requires a non-empty namespace allowlist unless `deny=true`. Allowlists fail closed when present (including empty). Engine kinds: ConfigMap, Service, Deployment, StatefulSet, DaemonSet, Job, CronJob, Ingress, NetworkPolicy. Engine verbs: `get` (`kubernetes.get`), `list` (`kubernetes.list`), `apply` (`kubernetes.apply`), `watch` (`kubernetes.rolloutStatus`). `expiresIn` must be a valid ISO-8601 duration (max `P7D`). |

Workflow publish fails closed if a YAML resource UUID is missing, unpublished, disabled, or in another workspace. Execution JSON includes `pins[]` copied from the workflow version; later ops-config publishes do not change that pin. **Authorization** on start re-evaluates the **current** published target/policy (E4.3), so a later policy/target publish can block dispatch even though the execution pin stays on the older revision.

## Policy evaluation and approvals (E4.3)

Evaluate target/action policy **before dispatch**. Approval requirements are bound to workflow version, target revision, policy revision, operation, and expiry. A changed policy, target, or workflow version invalidates a prior approval. Decide rechecks membership and `approval.decide` on the server. Requester self-approval is denied. This is the control-plane **boundary** (requirements + binding + fail-closed invalidation), not the E10 durable `flow.approval` wait/resume worker.

**UI route map (Chloe):** do **not** stack on another feature branch. These paths are stable on `main`. Cookie session + `credentials: "include"`; send `X-CSRF-Token` on POST. JSON is camelCase. Suggested screens: `/approvals` (inbox) and a pre-run policy panel on the workflow run dialog. Next proxies can rewrite `/api/control-plane/policy/evaluate` and `/api/control-plane/approvals/...`. Do not rewrite `apps/web` in this API story. Durable wait/resume UI stays disabled until E10.

Suggested UI flow:

1. Pre-run: `POST /policy/evaluate` `{workflowId, workflowVersionId}` → `{decision, dispatchAllowed, operations[], requirements[], approvals[]}`.
2. If `decision=deny`, block Run and show `denied[].reason`.
3. If `decision=approval-required`, `POST /approvals` `{workflowId, workflowVersionId}` (or let Run 409 after the server materializes pending rows). Inbox: `GET /approvals?status=pending`.
4. Approver (not the requester): `POST /approvals/{id}/decide` `{decision:"approved"|"rejected", note?}`. Requires `approval.decide` plus the bound `approverRole` (or `admin`).
5. Run again: `POST /workflows/{id}/executions` `{workflowVersionId}`. Valid approvals → `201`. Missing/stale/expired → `409` `conflict`. Policy deny → `403`.
6. After a policy or target **publish** (or disable), prior pending/approved rows become `invalidated`. Re-evaluate and request a new approval.
7. Detail/audit: `GET /approvals/{id}`, `GET /approvals/{id}/events`. Catalog: `GET /approvals/catalog`.

RBAC: `approval.view` list/get/events/catalog/evaluate; `workflow.execute` create requirements; `approval.decide` decide (approver/admin). Viewer can read status. Operator can request, not decide. Host-supplied `id` / `workspace_id` / `workspaceId` on write bodies is `400`. Cross-workspace UUIDs are `404`.

| Route | Purpose | Success | Failure |
| --- | --- | --- | --- |
| `GET /api/v1/approvals/catalog` | Statuses, decisions, default expiry. Requires `approval.view`. | `200` `{statuses,decisions,defaultExpiresIn}` | `401` `403` |
| `POST /api/v1/policy/evaluate` | Preview current published target/policy vs a workflow version. Requires `workflow.view`. | `200` evaluation | `400` `401` `403` `404` |
| `GET /api/v1/approvals` | List. Query `status`, `workflowId`, `workflowVersionId`, `executionId`. Refreshes stale rows. | `200` `{items}` | `401` `403` |
| `POST /api/v1/approvals` | Materialize pending requirements from evaluate. Idempotent on active fingerprint. Requires `workflow.execute`. | `201` `{items}` | `400` `401` `403` `404` |
| `GET /api/v1/approvals/{approvalId}` | One requirement; refreshes expiry/binding. | `200` | `401` `403` `404` |
| `POST /api/v1/approvals/{approvalId}/decide` | Fresh auth. `{decision, note?}`. No self-approval. | `200` | `400` `401` `403` `404` `409` (expired/invalidated/not pending) |
| `GET /api/v1/approvals/{approvalId}/events` | Secret-free audit. | `200` `{items}` | `401` `403` `404` |
| `POST /api/v1/workflows/{workflowId}/executions` | **Also** evaluates policy before the pin stub. Approval-required without a valid approval is `409` (pending rows are created). Deny is `403`. | `201` execution | `400` `401` `403` `404` `409` |

Statuses: `pending`, `approved`, `rejected`, `expired`, `invalidated`. Binding fields on every requirement/record: `workflowVersionId`, `workflowDigest`, `targetId`/`targetVersionId`/`targetDigest`, `policyResourceId`/`policyVersionId`/`policyDigest`/`policyRevision`, `operation`, `nodeId`, `expiresAt`, `bindingFingerprint`.

`flow.approval` nodes always produce a requirement (`with.approverRole`, `with.expiresIn`). A kubernetes/ssh/http/notification/script policy produces a requirement when `kind=approval` or `policy.requireApproval=true`. Allowlists fail closed when present (a present empty list denies). Cluster-target `allowedNamespaces` is also enforced at evaluate. A `policyId` that is not a published policy in the workspace is deny. No bound policy means no extra constraint (existing E4.2 workflows still run).

## Kubernetes target and policy management (E7.1)

Control-plane hardening on the existing E4.2 collections. E7.2 adds the apply/get/list engine. E7.3 fulfills `kubernetes.rolloutStatus` and `wait=ready` bounded watch.

**UI route map (Chloe):** same cookie session + `X-CSRF-Token` + camelCase JSON as E4.2. Use `GET /ops-config/catalog` (`kubernetesEngine`) or `GET /kubernetes/catalog` for allowlists, evaluation-key aliases, and service-account template paths. Cluster-target credential pickers must list only workspace `type=kubernetes` credentials (secret field `kubeconfig`, never shown). Host-supplied `id` / `workspaceId` is `400`. Cross-workspace credential or resource UUIDs are `404`. Next can proxy `/api/control-plane/kubernetes/catalog` the same way as ops-config. Do not rewrite `apps/web` in this API story.

Suggested UI flow:

1. Create a vault credential `type=kubernetes` (E4.1). Never echo kubeconfig.
2. Optionally create/publish a `policies` resource with `kind=kubernetes` and a non-empty `allowedNamespaces` (or `namespaces`). Add `allowedKinds` / `allowedVerbs` to fail closed on those axes.
3. Create/publish a `cluster-targets` draft: `{name, spec:{credentialId, endpoint:{apiServer}, allowedNamespaces?, policyId?, serviceAccount?}}`.
4. Select as today (`POST /cluster-targets/{id}/select`). Publish/select re-checks credential type, required fields, empty allowlists, and namespace subset vs the bound policy.
5. Apply `deploy/kubernetes/workspace-*.yaml` in each allowed namespace (operator, not FlowForge). E7.2 workers will read `serviceAccount` metadata.

Least-privilege SA templates (no ClusterRoles): [`deploy/kubernetes/`](../../deploy/kubernetes/). Default name `flowforge-runner`, `roleTemplate=namespace-scoped-runner`.

## Kubernetes read/apply nodes (E7.2)

Engine path for `kubernetes.apply`, `kubernetes.get`, and `kubernetes.list`. No new browser routes. Workers claim E5.2 jobs and call the engine; kubeconfig never appears on job JSON, outputs, or audit details. `GET /kubernetes/catalog` now includes `nodes[]`, `errors[]`, and `apply` (fieldManager/`Force=false`/always server dry-run). The live workflow catalog is `GET /workflows/catalog` (`allowedWith`, `policy`, `bounds`, `redaction`).

**UI route map (Chloe):** do **not** stack on another feature branch. Cookie session + `credentials: "include"`; send `X-CSRF-Token` on POST. JSON is camelCase. Host-supplied `id` / `workspaceId` is `400`. Do not rewrite `apps/web` in this API story. Wizard/library should read `allowedWith` on the three nodes instead of inferring fields.

### Node contracts

Shared fields: `clusterTargetId` (UUID), `namespace` (DNS-1123), `dryRun` (`client`|`server`), `wait` (`none`|`ready`), `timeoutSeconds` (1–3600, default 60), optional `fieldManager` (`flowforge` only), optional `policyId` (UUID). `client` dry-run adds local validation and **never** replaces the mandatory server-side dry-run on apply. `wait=ready` performs a bounded watch of observable kinds (see E7.3).

| Node | Extra `with` | Verb | Permissions | Outputs |
| --- | --- | --- | --- | --- |
| `kubernetes.apply` | `manifests` (YAML string) | `apply` | `workflow.execute`, `kubernetes.apply`, `clusterTarget.use` | `result`, `resources`, `status` |
| `kubernetes.get` | `kind` (allowlisted), `name` | `get` | `workflow.execute`, `kubernetes.read`, `clusterTarget.use` | `result`, `items` |
| `kubernetes.list` | `kind` (allowlisted) | `list` | `workflow.execute`, `kubernetes.read`, `clusterTarget.use` | `result`, `items` |

Apply flow: parse YAML docs → validate kind/namespace/secret/workload/image/ingress policy → revalidate policy → SSA dry-run (`dryRun=All`) → SSA apply `FieldManager=flowforge` `Force=false`. Ownership conflicts are `409` `ownership-conflict` and are never forced. Get/list contact only the node namespace.

Allowlisted kinds: ConfigMap, Service, Deployment, StatefulSet, DaemonSet, Job, CronJob, Ingress, NetworkPolicy. Denied: Secret `data`/`stringData`/`binaryData`, cluster-scoped, Namespace, CRDs, RBAC, admission webhooks, privileged/hostPath/host namespaces, capability escalation, mutable tags including `:latest`, images not on `allowedImages`/`images`, Ingress hosts/TLS/backends/annotations outside `allowedIngressHosts`/`ingressHosts`.

### Result / error shapes

Success `result`: `{ok, operation, clusterTargetId, namespace, manifestDigest?, fieldManager:"flowforge", force:false, serverDryRun, applied, wait, observation?, resources[], items?, status, policyRevision?, policyDigest?, correlationId?}`. Outputs are redacted (`kubeconfig`, secret keys, PEM).

| `error.code` | HTTP-ish | When |
| --- | --- | --- |
| `invalid-manifest` | 400 | Parse/required field |
| `secret-forbidden` | 400 | Secret kind or secret data fields |
| `kind-denied` / `namespace-denied` / `verb-denied` / `policy-denied` / `forbidden` / `rbac-denied` | 403 | Allowlist, RBAC, or FlowForge permission |
| `image-denied` / `ingress-denied` / `workload-denied` | 403 | Manifest security policy |
| `ownership-conflict` | 409 | Another field manager owns applied fields (`Force=false`) |
| `dry-run-failed` | 400 | Server-side dry-run rejected the object |
| `apply-failed` / `read-failed` / `timeout` | 502 / 404 / 408 | Cluster or bound timeout |

Job binding still includes workspace, workflow version, cluster target, policy revision, correlation ID, and normalized-manifest SHA-256. Workers revalidate policy before cluster contact.

Out of scope for E7.2: E7.3 `kubernetes.rolloutStatus` watch (now below), `apps/web` rewrite, SSH/script engines.

## Kubernetes rollout observation and audit (E7.3)

Bounded watch for `kubernetes.apply` when `wait=ready` and the dedicated `kubernetes.rolloutStatus` node. No new browser routes. `GET /kubernetes/catalog` adds `observation` (`waitReady=observed`, states, kinds, `verb=watch`, cancel/timeout = `stop-wait`, `neverDeletesOrRollsBack=true`) plus the `kubernetes.rolloutStatus` node. The live workflow catalog is `GET /workflows/catalog`.

**UI route map (Chloe):** do **not** stack on another feature branch and do **not** rewrite `apps/web` in this API story. Cookie session + `credentials: "include"`; send `X-CSRF-Token` on POST. JSON is camelCase. Host-supplied `id` / `workspaceId` is `400`. Wizard/library should read `allowedWith` / `observation` from `GET /kubernetes/catalog` and `GET /workflows/catalog`. Keep #72 open until rollout-status UI surfaces land.

Suggested UI flow:

1. Author `kubernetes.apply` with `wait=ready` (or a following `kubernetes.rolloutStatus` node).
2. Show `result.observation` and `result.status.progress[]` counters. Treat timeout/cancel as “stopped waiting” — never offer delete/rollback.
3. Render `result.audit` (or the matching `audit_events` row) as the secret-free snapshot: actor, target, policy revision, manifest digest, resource identities, dry-run/apply/watch outcome, correlation ID.
4. On `error.code` `timeout` / `canceled` / `rollout-failed`, keep the applied identities visible; the cluster objects remain.

### Node contracts

Shared fields match E7.2. `kubernetes.rolloutStatus` extra identity: `kind` + `name`, or `resource` `{kind,name}`, or a wired `resource` input. Observable kinds only: Deployment, StatefulSet, DaemonSet, Job. Verb is `watch` (E7.1 allowlist). Cancel/timeout stop the wait and **never** delete or roll back.

| Node | Extra `with` | Verb | Permissions | Outputs |
| --- | --- | --- | --- | --- |
| `kubernetes.apply` (`wait=ready`) | `manifests` | `apply` then `watch` | `workflow.execute`, `kubernetes.apply`, `clusterTarget.use` (watch also requires policy `watch`) | `result`, `resources`, `status` |
| `kubernetes.rolloutStatus` | `kind`+`name` or `resource` | `watch` | `workflow.execute`, `kubernetes.read`, `clusterTarget.use` | `result`, `status` |

Non-observable apply kinds (ConfigMap, Service, CronJob, Ingress, NetworkPolicy) with `wait=ready` return `observation=skipped` and do not require `watch`.

### Observation states

| `result.observation` | Meaning |
| --- | --- |
| `ready` | Watched object reached the kind’s ready condition (see below). |
| `failed` | Job `Failed=True` or Deployment `Progressing` `ProgressDeadlineExceeded`. |
| `timeout` | `timeoutSeconds` elapsed. Resources left in place. |
| `canceled` | Caller/context canceled. Resources left in place. |
| `skipped` | Kind is not observable, or apply `wait=ready` had no watchable docs. |
| `progressing` | Intermediate poll state only; not a terminal result. |

Ready conditions (secret-free counters on `status.progress[]`):

- **Deployment:** `observedGeneration >= generation`, `updated/ready/availableReplicas == spec.replicas`, `unavailableReplicas == 0`, `Available=True` when present.
- **StatefulSet:** `readyReplicas == spec.replicas` (and `updatedReplicas` when reported).
- **DaemonSet:** `updatedNumberScheduled` and `numberAvailable` equal `desiredNumberScheduled`.
- **Job:** `Complete=True` or `succeeded >= completions`; `Failed=True` is `failed`.

`status.progress[]` fields: `kind`, `namespace`, `name`, `generation`, `observedGeneration`, replica/job counters, `state`, `reason`. No raw object dump, Secret data, or kubeconfig.

### Result / audit / error shapes

Success `result` extends E7.2 with `observation` (`ready`/`skipped`/…), `status.progress[]`, and `audit`. `audit` (and the persistable snapshot) is secret-free: `actorId`, `operation`, `clusterTargetId`, `namespace`, `policyRevision`, `policyDigest`, `manifestDigest`, `resources[]`, `serverDryRun`, `applied`, `watch`, `observation`, `correlationId`, `outcome`, optional `errorCode`.

| `error.code` | HTTP-ish | When |
| --- | --- | --- |
| (E7.2 codes unchanged) | | |
| `timeout` | 408 | Bounded watch elapsed. No delete/rollback. |
| `canceled` | 408 | Observation canceled. No delete/rollback. |
| `rollout-failed` | 409 | Deployment deadline exceeded or Job failed. No delete/rollback. |
| `verb-denied` / `rbac-denied` | 403 | Policy or Kubernetes RBAC denied `watch`. |

Out of scope: `apps/web` rewrite, deletion, rollback, force apply, SSH/script engines.

## SSH target and command-profile management (E8.1)

Control-plane hardening on the existing E4.2 `ssh-targets` / `command-profiles` collections. E8.2 adds the isolated `ssh.run` worker. E8.3 implements retry/indeterminate semantics (`retrySafe` is schema-only here).

**UI route map (Chloe):** same cookie session + `X-CSRF-Token` + camelCase JSON as E4.2. Use `GET /ops-config/catalog` (`sshEngine`) or `GET /ssh/catalog` for parameter types, render rules, retry-safe flags, and error codes. SSH-target credential pickers must list only workspace `type=ssh_private_key` credentials (secret fields `privateKey` / `passphrase`, never shown). Host-supplied `id` / `workspaceId` is `400`. Cross-workspace credential or resource UUIDs are `404`. Next can proxy `/api/control-plane/ssh/catalog` the same way as kubernetes/ops-config. Do not rewrite `apps/web` in this API story. Keep #82 open until target/profile UI surfaces land.

Suggested UI flow:

1. Create a vault credential `type=ssh_private_key` (E4.1). Never echo the private key or passphrase.
2. Optionally create/publish a `policies` resource with `kind=ssh` and `allowedHosts` / `allowedAddresses` (empty present lists are rejected).
3. Create/publish an `ssh-targets` draft: `{name, spec:{credentialId, hostname, hostKeyFingerprint, port?, allowedAddresses?, policyId?}}`.
4. Create/publish a `command-profiles` draft: `{name, spec:{parameterSchema, template, retrySafe?, policyId?}}`. Template placeholders are `{name}` only. The API renderer quotes string values with POSIX single quotes; it never interpolates `$()`, backticks, `${`, or `{{`.
5. Select as today (`POST /ssh-targets/{id}/select`, `POST /command-profiles/{id}/select`). Publish/select re-checks credential type, fingerprint format, allowlists, and parameter schema. Workflow publish pins the exact target + profile revisions and rejects `ssh.run` parameters outside the pinned schema.
6. Later draft edits do **not** retarget a pin. Published revisions are immutable. Drafts remain editable to create the next revision.

### `spec` field map

**`ssh_target`**

| Field | Required | Type | Notes |
| --- | --- | --- | --- |
| `credentialId` | yes | UUID | Workspace `ssh_private_key` only |
| `hostname` | yes | string | DNS name or IP; lowercased |
| `hostKeyFingerprint` | yes | string | `sha256:<64 hex>` or OpenSSH `SHA256:<base64>` |
| `port` | no | integer | Default `22`; range 1–65535 |
| `allowedAddresses` | no | string[] | IP or CIDR; present empty → `400`; no default-route CIDR |
| `policyId` | no | UUID | Published `kind=ssh` policy |

**`command_profile`**

| Field | Required | Type | Notes |
| --- | --- | --- | --- |
| `parameterSchema` | yes | object | `{type:"object", additionalProperties:false, required?, properties}` |
| `parameterSchema.properties.*` | — | object | `type`: `string` \| `integer` \| `boolean`. String: `enum`, `minLength`, `maxLength`, `pattern`, `sensitive`. Integer: `enum`, `minimum`, `maximum`. Names: `[A-Za-z][A-Za-z0-9_]{0,31}`. Max 16 properties. |
| `template` | yes | string | Reviewed command with `{name}` placeholders matching properties. No interpolation tokens. |
| `retrySafe` | no | boolean | Default `false`. Semantics are E8.3. |
| `policyId` | no | UUID | Published `kind=ssh` policy |

### Catalog (`GET /ssh/catalog`)

| Field | Purpose |
| --- | --- |
| `credentialType` | `ssh_private_key` |
| `credentialSecretFields` | `privateKey`, `passphrase` (never returned on ops-config) |
| `parameterTypes[]` | Allowed schema types + constraints |
| `render` | `owner=reviewed-profile-renderer`, `quoting=posix-single-quotes`, `rawShellInterpolation=false`, forbidden tokens |
| `retry` | `defaultMaxAttempts=0`, `retrySafeFlag`, `semantics=E8.3` |
| `publishRules` | Required fields, empty-allowlist rejection, fingerprint format, pin immutability |
| `evaluationKeys[]` | SSH policy aliases (`allowedHosts`/`hosts`, `allowedAddresses`/`addresses`) |
| `nodes[]` | `ssh.run` wizard map (`sshTargetId`, `commandProfileId`, `parameters`, `timeoutSeconds`, `retryPolicy`) |
| `errors[]` | Codes for Chloe: `invalid-target`, `invalid-fingerprint`, `invalid-address`, `empty-allowlist`, `invalid-schema`, `invalid-template`, `interpolation-denied`, `parameter-rejected`, `credential-denied`, `forbidden` |
| `permissions[]` | `workflow.execute`, `ssh.run`, `sshTarget.use`, `commandProfile.use` |

RBAC: `opsconfig.view` list/get/select/catalog; `opsconfig.edit` create/save/disable; `opsconfig.publish` publish; execute paths require `sshTarget.use` and `commandProfile.use` plus `ssh.run`. Viewer can read catalogs; editor can draft; publisher can publish revisions.

Out of scope: isolated `ssh.run` worker, ephemeral keys, fake SSH server (E8.2); indeterminate/retry semantics (E8.3); `apps/web` rewrite.

Out of scope: E10 webhook/schedule triggers, durable wait/resume across worker loss, provider engines.

Types: `kubernetes` (`secret.kubeconfig`), `ssh_private_key` (`privateKey`, optional `passphrase`), `token` (`token`), `webhook_secret` (`secret`), `provider` (`token`). Metadata cannot store those secret keys. `fingerprint` is `sha256:<hex>` of canonical secret JSON (not reversible).

## Workflow YAML contract (E3.1)

Ephemeral parse/normalize/validate. Persistence is E3.2 below. Browser callers use the E2.3 session + CSRF pair; header-only callers skip CSRF.

**UI route map (Chloe):** `/workflows` is the E3.1 YAML operator, the E3.2 draft/publish/history operator, and the E3.3 core-neutral node palette/inspector (not the E6 canvas). Debounce YAML edits against validate; on Save-preview or import, call normalize and replace the editor buffer with `definitionYaml`. Show digest + `summary` counts; do not guess a graph on `invalid-workflow` — render `errors[]` (`path`, `line`, `column`, `code`, `message`). Catalog palette is `phase: core` only (`next` / `provider` fail closed). The E3.3 action palette further limits insert to the seven core neutral node types and never places triggers as graph nodes. Do not persist credentials or host-supplied workspace IDs in YAML.

The Next UI proxies E3.1 routes under `/api/control-plane/workflows/{catalog,validate,normalize}` and E3.2 routes under `/api/control-plane/workflows`, `/{workflowId}`, `.../draft`, `.../publish`, `.../compare`, `.../versions`, `.../export`, `.../restore`, and `.../executions` with session cookies, CSRF on POST/PUT, `If-Match` on draft save, workspace tenant + workbench headers, and preserved `application/problem+json` including `errors[]`.

| Route | Purpose | Success | Failure |
| --- | --- | --- | --- |
| `GET /api/v1/workflows/catalog` | Core trigger/node types, ports, and required `with` fields. E3.3 adds `rules` plus per-node `allowedWith`, `policy`, `bounds`, `redaction`, and port `classification` / `maxBytes` for the seven core neutral nodes. E7.2 adds the same metadata on `kubernetes.apply` / `get` / `list`. E7.3 adds `kubernetes.rolloutStatus` (`verb=watch`, `cancellation=stop-wait`). Requires `workflow.view`. | `200` `{apiVersion,rules,triggers,nodes}` | `401` `403` |
| `POST /api/v1/workflows/validate` | Parse + graph validation. Body `application/yaml` or JSON `{definitionYaml}`. Requires `workflow.edit`. | `200` `{valid,summary,warnings}` | `400` `invalid-workflow` (with `errors`) / `401` `403` `413` |
| `POST /api/v1/workflows/normalize` | Validate, emit deterministic YAML, SHA-256 digest. Same body as validate. Requires `workflow.edit`. | `200` `{definitionYaml,digest,summary,warnings}` | `400` `invalid-workflow` (with `errors`) / `401` `403` `413` |

Parser limits: 256 KiB document, 4096 YAML nodes, depth 32, 64 KiB scalars, 128 workflow nodes. Rejected: custom tags, aliases, merge keys, duplicate keys, multiple documents, templates (`{{`, `${`, `{%`), unknown fields, next/provider node types, cycles, disconnected nodes, invalid/incompatible ports, non-UUID resource refs, secret/credential keys, Secret manifests, raw SSH commands.

**E3.3 core neutral contracts** (`flow.condition`, `flow.delay`, `data.set`, `data.map`, `data.validate`, `flow.stop`, `flow.fail`): allowlisted `with` only; 16 KiB port/`with` caps; 32 aggregation items; delay max `P7D`; `data.set` public/internal literals only; mapping/condition paths are dotted identifiers (no expression language); `flow.fail` requires `code`. New field codes: `classification-denied`, `output-too-large`, `aggregation-limit`, `invalid-schema`, `duration-limit`, `expression-forbidden`. Triggers remain `spec.triggers`, never graph nodes. Full catalog/schema map: [core node contracts](core-node-contracts.md). Evaluation is a Go contract package (deterministic, no durable worker sleep) used by validate when literal inputs are present — not the E5 engine.

Digest format: `sha256:<hex>` of normalized YAML. Normalization sorts labels, triggers, nodes, edges, and outputs by id/name and emits a single trailing newline. Literal blocks (`manifests`, `source`) keep inner text except trailing-newline normalization.

## Drafts, publish, and versions (E3.2)

Server-derived workspace scope, FORCE RLS, and composite `(workspace_id, id)` FKs apply. Only **normalized** YAML is stored. Published `workflow_versions` rows are immutable (trigger + `flowforge_app` has INSERT/SELECT only). Execution start pins a version/digest and, as of E5.1, persists redacted steps, jobs, and audit events.

**UI route map (Chloe):** persist drafts through these shapes. `/workflows` and the Next proxies under `/api/control-plane/workflows/...` are in place. JSON field names are camelCase (`definitionYaml`, `draftRevision`, `workflowVersionId`). Host-supplied `id` / `workspace_id` / `workspaceId` on write bodies is `400`. Cross-workspace UUIDs are `404`. Cookie sessions send `X-CSRF-Token` on POST/PUT.

Suggested UI flow:

1. `POST /workflows` (import/create) → keep `workflow.id` and `draft.revision`.
2. Debounced `POST /workflows/validate` while editing; Save calls `PUT /workflows/{id}/draft` with the last seen `revision`.
3. On `200`, replace the editor buffer with `draft.definitionYaml` and store `draft.revision` / `draft.digest`.
4. On `409` `conflict`, `GET` the draft and offer reload (stale tab).
5. Publish: `POST /workflows/{id}/publish` `{revision, note}` (`workflow.publish`).
6. History: `GET /workflows/{id}/versions`; export `GET .../versions/{versionId}/export`; compare `POST /workflows/{id}/compare`; restore `POST .../versions/{versionId}/restore`.
7. Run: only `POST /workflows/{id}/executions` `{workflowVersionId}`. Never send `draft: true` / omit the version.

| Route | Purpose | Success | Failure |
| --- | --- | --- | --- |
| `GET /api/v1/workflows` | List summaries (no YAML). Requires `workflow.view`. | `200` `{items}` | `401` `403` |
| `POST /api/v1/workflows` | Create workflow + draft revision 1. JSON `{definitionYaml, slug?, name?}`. Requires `workflow.edit`. | `201` `{workflow,draft}` | `400` `invalid-workflow` / `401` `403` `409` (slug) |
| `GET /api/v1/workflows/{workflowId}` | Summary including `draftRevision`, `draftDigest`, latest version. | `200` workflow | `401` `403` `404` |
| `GET /api/v1/workflows/{workflowId}/draft` | Current mutable draft. | `200` `{workflowId,revision,definitionYaml,digest,summary,warnings,validationState}` | `401` `403` `404` |
| `PUT /api/v1/workflows/{workflowId}/draft` | Conflict-safe save. JSON `{revision,definitionYaml}` or YAML + `If-Match: <revision>`. Requires `workflow.edit`. | `200` `{workflow,draft}` (revision incremented) | `400` `invalid-workflow` / `409` revision mismatch / `401` `403` `404` |
| `POST /api/v1/workflows/{workflowId}/publish` | Copy current draft to an immutable version. JSON `{revision?,note?}`. Requires `workflow.publish`. | `201` `{workflow,version}` | `409` duplicate digest or stale revision / `401` `403` `404` |
| `GET /api/v1/workflows/{workflowId}/versions` | Version history, newest first. | `200` `{items}` | `401` `403` `404` |
| `GET /api/v1/workflows/{workflowId}/versions/{versionId}` | One frozen snapshot (includes YAML). | `200` version | `401` `403` `404` |
| `GET /api/v1/workflows/{workflowId}/versions/{versionId}/export` | Immutable export. JSON `{filename,definitionYaml,digest,...}`; `Accept: application/yaml` returns raw YAML. | `200` | `401` `403` `404` |
| `POST /api/v1/workflows/{workflowId}/compare` | Diff two refs. `{left:{kind:"draft"}, right:{kind:"version",versionId}}` (or `versionNumber`). | `200` `{equal,digestMatch,left,right,leftDigest,rightDigest,changes[]}` | `400` `401` `403` `404` |
| `POST /api/v1/workflows/{workflowId}/versions/{versionId}/restore` | Restore version as a **new** draft revision. JSON `{expectedRevision?}`. Requires `workflow.edit`. Version is unchanged. | `200` `{workflow,draft}` | `409` stale draft / `401` `403` `404` |
| `POST /api/v1/workflows/{workflowId}/executions` | Start a durable run. **Requires** `workflowVersionId`. Drafts / missing version → `400`. Requires `workflow.execute`. Pins `workflowVersionId` + `workflowDigest`. Optional `idempotencyKey` / `Idempotency-Key` is unique on `(workspace, workflowVersionId, key)`. Same fingerprint → `200` `{replayed:true}` (no new steps/jobs). Different fingerprint → `409`. Inputs redacted before persist. E4.3 evaluates current target/action policy first: deny → `403`; approval required without a valid bound approval → `409`. | `201` / `200` execution | `400` drafts cannot run / `401` `403` `404` `409` |
| `GET /api/v1/workflows/{workflowId}/executions` | List runs for one workflow. Requires `execution.view`. Query `status`, `limit`. | `200` `{items}` | `401` `403` `404` |
| `GET /api/v1/workflows/{workflowId}/executions/{executionId}` | Execution detail (redacted `input`, `steps`, `jobs`, `pins`, `auditEvents`). Requires `execution.view`. Later draft edits do not change digest/version. | `200` | `401` `403` `404` |

## Durable executions (E5.1)

PostgreSQL model for executions, steps, jobs, and append-only `audit_events`. E5.2 uses the reserved lease/fencing columns for claim/heartbeat/recovery. Artifact downloads are E5.3.

**UI route map (Chloe):** do **not** stack on another feature branch. These paths are stable against `main`. Cookie session + `credentials: "include"`; send `X-CSRF-Token` on POST. JSON is camelCase. Host-supplied `id` / `workspace_id` / `workspaceId` on write bodies is `400`. Cross-workspace UUIDs are `404`. Do not rewrite `apps/web` in this API story. Suggested screens: `/executions` (workspace history) and `/executions/{id}` (detail with redacted steps). Artifact list/download is E5.3 below. Next proxies can rewrite `/api/control-plane/executions` and `/api/control-plane/workflows/{id}/executions`.

Suggested UI flow:

1. Run: `POST /workflows/{workflowId}/executions` `{workflowVersionId, idempotencyKey?, input?}`. Keep `id`. Never send `draft: true`.
2. Same `idempotencyKey` + same input/actor → `200` with the original `id` and `replayed: true`. Do not treat that as a second run.
3. Same key + different `input` (or actor) → `409` `conflict`. Show a safe message; do not retry with a new key unless the operator intends a new run.
4. Workspace history: `GET /executions?status=&workflowId=&limit=`. Per-workflow: `GET /workflows/{workflowId}/executions`.
5. Detail: `GET /executions/{executionId}` (or the workflow-scoped twin). Render `status`, version/digest pin, redacted `input`, bounded `steps[]` (`outputTruncated`), `jobs[]`, `pins[]`, and `artifacts[]` metadata (E5.3).
6. Optional extra fetches: `GET /executions/{id}/steps`, `/jobs`, `/audit-events`, `/artifacts`. Workspace audit: `GET /audit-events?resourceType=execution&resourceId=`.
7. Secret values are already `[redacted]` in JSON. Never persist `input` from the run form into `localStorage`.

Statuses: `queued`, `pinned` (legacy stub), `running`, `succeeded`, `failed`, `canceled`, `indeterminate`. New starts are `queued` with one step+job per published node (`attempt=1`). Workers claim jobs via `/jobs/*`; the UI cancels/retries via `/executions/{id}/cancel` and `/retry`. Do not claim jobs from the browser.

Retention: executions `retentionUntil` default 90 days; audit events 365 days. Monthly partitions apply to `audit_events` only.

| Route | Purpose | Success | Failure |
| --- | --- | --- | --- |
| `GET /api/v1/executions` | Workspace history. Query `workflowId`, `status`, `limit` (1–100, default 50). Requires `execution.view`. | `200` `{items}` | `401` `403` |
| `GET /api/v1/executions/{executionId}` | Detail + redacted steps/jobs/pins/audit + artifact metadata. | `200` | `401` `403` `404` |
| `GET /api/v1/executions/{executionId}/steps` | Redacted step list. | `200` `{items}` | `401` `403` `404` |
| `GET /api/v1/executions/{executionId}/steps/{stepId}` | One step. | `200` | `401` `403` `404` |
| `GET /api/v1/executions/{executionId}/jobs` | Dispatch records. | `200` `{items}` | `401` `403` `404` |
| `GET /api/v1/executions/{executionId}/audit-events` | Redacted start/replay audit for that run. | `200` `{items}` | `401` `403` `404` |
| `GET /api/v1/audit-events` | Workspace audit log (`resourceType`, `resourceId`, `action`, `limit`). Distinct from E2.2 `GET /workspace/audit-events`. | `200` `{items}` | `401` `403` |

## Durable dispatch (E5.2)

Authenticated jobs, single active claim, heartbeat, fencing tokens, lease expiry, cancel, and retry. Workers must re-validate the claim `binding` (workspace, workflow version/digest, policy digest, expiry) before any provider call. Altered HMAC `jobToken`s are `403`. Expired tickets/leases are `409`. Cross-workspace job IDs are `404`. Lease loss after claim/heartbeat is `indeterminate` — never a silent provider retry.

**UI route map (Chloe):** do **not** stack on another feature branch. These paths are stable against `main`. Cookie session + `credentials: "include"`; send `X-CSRF-Token` on POST. JSON is camelCase. Host-supplied `id` / `workspace_id` / `workspaceId` on write bodies is `400`. Cross-workspace UUIDs are `404`. Do not rewrite `apps/web` in this API story. Suggested screens: execution detail cancel + retry buttons, unmistakable `indeterminate` badge. Next proxies can rewrite `/api/control-plane/executions/{id}/cancel`, `.../retry`, `.../steps/{stepId}/retry`. Worker routes stay off the browser.

Suggested UI flow:

1. Status: keep polling `GET /executions/{id}` (`steps[]`, `jobs[]`). Show `leaseExpiresAt`, `heartbeatAt`, `workerId`, `fencingToken` as diagnostics only.
2. Cancel: `POST /executions/{id}/cancel` `{}` with CSRF. Requires `execution.cancel` (operator/admin). Viewer/approver → `403`. Already canceled → `200` (idempotent). `succeeded` / `failed` / `indeterminate` → `409`.
3. Retry: only for `failed` or `canceled` **core** `data.*` / `flow.*` steps. `POST /executions/{id}/steps/{stepId}/retry` `{}` or `POST /executions/{id}/retry` `{stepId?}`. Requires `workflow.execute`. `201` `{execution,step,job}` with `attempt+1` queued. Provider nodes and `indeterminate` → `409`.
4. Do **not** call `/jobs/claim` from the UI. That is the worker client.

Worker client (not the UI):

1. `POST /jobs/claim` `{workerId, leaseSeconds?}` → `200` `{claimed, jobToken, binding, job, step, execution}` or `204`.
2. Reject the job if `binding.workspaceId` is not this worker's workspace, `binding.expiresAt` is past, or `workflowVersionId` / `workflowDigest` do not match the pinned execution.
3. `POST /jobs/{jobId}/heartbeat` `{jobToken, workerId, fencingToken, leaseSeconds?}` — first heartbeat marks `running` (the provider fence). Then call the provider at most once.
4. `POST /jobs/{jobId}/complete` `{jobToken, workerId, fencingToken, output?}` or `.../fail` `{..., error?}`.
5. Graceful idle release (no heartbeat yet): `POST /jobs/{jobId}/release`. After heartbeat, release becomes `indeterminate`.
6. Crash/lease loss: `POST /jobs/recover` (also runs on the next claim). Expired `claimed`/`running` jobs become `indeterminate`. A stale `jobToken` cannot complete.

Default lease **30s** (min 1s, max 5m). `JOB_BINDING_SECRET` (32-byte base64/hex) HMACs tickets; an unset secret is an ephemeral process key.

| Route | Purpose | Success | Failure |
| --- | --- | --- | --- |
| `POST /api/v1/jobs/claim` | Claim next queued job. Recovers expired leases first. Requires `workflow.execute`. | `200` ticket or `204` empty | `400` `401` `403` |
| `POST /api/v1/jobs/recover` | Sweep expired leases to `indeterminate`. | `200` `{recovered}` | `401` `403` |
| `POST /api/v1/jobs/{jobId}/heartbeat` | Extend lease; mark `running`. Requires matching `jobToken` + fence. | `200` | `400` `401` `403` `404` `409` |
| `POST /api/v1/jobs/{jobId}/release` | Requeue if not yet running; otherwise `indeterminate`. | `200` | `400` `401` `403` `404` `409` |
| `POST /api/v1/jobs/{jobId}/complete` | Succeed with redacted `output`. | `200` | `400` `401` `403` `404` `409` |
| `POST /api/v1/jobs/{jobId}/fail` | Fail with redacted `error`. | `200` | `400` `401` `403` `404` `409` |
| `POST /api/v1/executions/{executionId}/cancel` | Cancel open steps/jobs. Requires `execution.cancel`. Idempotent. | `200` detail | `401` `403` `404` `409` |
| `POST /api/v1/executions/{executionId}/retry` | Retry latest failed/canceled eligible step. Requires `workflow.execute`. | `201` | `401` `403` `404` `409` |
| `POST /api/v1/executions/{executionId}/steps/{stepId}/retry` | Retry one step. | `201` | `401` `403` `404` `409` |

## Execution artifacts (E5.3)

Redacted step state, bounded logs/output, envelope-encrypted artifact metadata, short-lived download grants, retention deletion, and legal hold. Object payloads are encrypted at rest (same `CREDENTIAL_KEK` envelope as the vault). Local MVP storage is the filesystem under `ARTIFACT_STORE_DIR` (compose/k8s: `/tmp/flowforge-artifacts` on the read-only container tmpfs). Empty `ARTIFACT_STORE_DIR` uses in-process memory (lost on restart). The API **never** returns `storageRef`, DEK/envelope fields, bucket names, or durable public URLs.

**UI route map (Chloe):** do **not** stack on this feature branch. Paths are intended to be stable on `main`. Cookie session + `credentials: "include"`; send `X-CSRF-Token` on POST. JSON is camelCase. Host-supplied `id` / `workspaceId` / `storageRef` / `url` / `bucket` / `key` on write bodies is `400`. Cross-workspace UUIDs are `404`. Do not rewrite `apps/web` in this API story. Do not call object-store APIs. Do not persist download `href`s. Isolation hook `GET /workspace/artifacts/{id}` is **not** the product artifact API.

Suggested Next proxies: `/api/control-plane/executions/{id}/artifacts`, `.../steps/{stepId}/logs`, `/artifacts/{id}`, `.../downloads`, `/artifact-downloads/{grantId}`, `.../legal-hold`, `/retention/purge`.

Suggested UI flow:

1. Poll `GET /executions/{id}` — `steps[]` (bounded, `outputTruncated`) and `artifacts[]` (metadata only). Optional `GET /executions/{id}/artifacts?stepId=&kind=`.
2. Logs: `GET /executions/{id}/steps/{stepId}/logs?limit=&offset=&maxBytes=`. Default window 200 lines / 16KiB; max 200 lines / 256KiB. Tokens are already `[redacted]` in stored logs.
3. Download: `POST /artifacts/{id}/downloads` `{}` → `{download:{id,artifactId,expiresAt,href,method:"GET"}}` then `GET {href}` with cookies. Re-request a grant if `404` (expired). Default grant TTL **60s** (`ARTIFACT_DOWNLOAD_TTL`), max 5m. Auth is re-evaluated on **every** grant and stream request.
4. Never render or store `storageRef`, `dekEnvelope`, `ciphertext`, bucket URLs, or a grant `href` past its expiry.
5. Legal hold / purge are admin-only (`workspace.administer`); not required for the artifact viewer.

Worker/operator upload (not the browser viewer): `POST /executions/{id}/artifacts` or `POST /executions/{id}/steps/{stepId}/artifacts` (or `.../logs`) with `{kind,filename,contentType,contentClassification,content|contentBase64}`. Scan rejects PEM private keys, kubeconfig, K8s Secret manifests, AWS secret keys, and `secret`/`restricted` classification **before** persist (`400`, audit `artifact.upload.rejected`). Allowed `contentType`: `text/plain`, `application/json`, `application/octet-stream`. Caps: files 1MiB (`ARTIFACT_MAX_BYTES`), logs 256KiB, output 16KiB. Filename paths are stripped.

| Method | Path | Perm | CSRF | Notes |
| --- | --- | --- | --- | --- |
| `GET` | `/api/v1/executions/{executionId}` | `execution.view` | no | Includes `artifacts[]` metadata + bounded `steps[]` |
| `GET` | `/api/v1/executions/{executionId}/artifacts` | `execution.view` | no | `{items}` metadata. Query `stepId`, `kind` |
| `POST` | `/api/v1/executions/{executionId}/artifacts` | `workflow.execute` | yes | Upload. Host locators → `400`. Missing KEK → `503` |
| `POST` | `/api/v1/executions/{executionId}/steps/{stepId}/artifacts` | `workflow.execute` | yes | Upload bound to a step |
| `GET` | `/api/v1/executions/{executionId}/steps/{stepId}/logs` | `execution.view` | no | `{lines,offset,nextOffset,truncated,maxBytes}` |
| `POST` | `/api/v1/executions/{executionId}/steps/{stepId}/logs` | `workflow.execute` | yes | Upload; default `kind=log` |
| `GET` | `/api/v1/artifacts/{artifactId}` | `execution.view` | no | Metadata only. Expired without hold → `404` |
| `POST` | `/api/v1/artifacts/{artifactId}/downloads` | `execution.view` | yes | `{download:{href,method,expiresAt}}` same-origin grant |
| `GET` | `/api/v1/artifact-downloads/{grantId}` | `execution.view` | no | Stream bytes. Re-evals workspace + perm + retention + grant. `Cache-Control: no-store` |
| `POST` | `/api/v1/artifacts/{artifactId}/legal-hold` | `workspace.administer` | yes | `{hold, reason}` — reason required to place. Audit `artifact.legal_hold.*` |
| `POST` | `/api/v1/retention/purge` | `workspace.administer` | yes | Deletes metadata + object payload. Holds skipped. `{purged,held,executions,audits}` |

Artifact JSON fields: `id`, `executionId`, `executionStepId?`, `kind`, `filename`, `contentType`, `digest`, `sizeBytes`, `contentClassification` (`public`/`internal`/`confidential`), `redacted`, `expiresAt` (defaults to the execution `retentionUntil`), `legalHold`, `legalHoldReason?`, `legalHoldBy?`, `legalHoldAt?`, `createdAt`, `updatedAt`.

Out of scope: provider engines, `apps/web` rewrite.

## Audit integrity and operational alerts (E5.4)

`audit_events` are append-only for the `flowforge_app` role (SELECT + INSERT only). UPDATE always fails. DELETE of live rows fails; expired rows are removed only by `app.purge_expired_audit_events` (SECURITY DEFINER), which `POST /retention/purge` already calls. Tamper attempts fail closed.

Authorization, replay (idempotency fingerprint mismatch), policy deny, and redaction/unsafe-artifact failures emit an operational alert plus a secret-free `alert.{kind}` audit row. Alert JSON is identifiers only: no `details`, tokens, headers, bodies, or storage locators.

**UI route map (Chloe):** do **not** stack on this feature branch. Paths are intended to be stable on `main`. Cookie session + `credentials: "include"`; send `X-CSRF-Token` on POST. JSON is camelCase. Host-supplied `id` / `workspaceId` on ack is `400`. Cross-workspace UUIDs are `404`. Do not rewrite `apps/web` in this API story. Suggested screens: `/alerts` (open queue) and `/alerts/{id}` (detail + ack). Next proxies can rewrite `/api/control-plane/alerts`, `/{id}`, `/{id}/ack`.

Suggested UI flow:

1. Nav: show Alerts when `GET /workspace` includes `alert.view`. Ack controls require `alert.ack` (operator/admin). Viewer/approver can read.
2. Queue: `GET /alerts?kind=&status=open&resourceType=&resourceId=&limit=`. Kinds: `authorization`, `replay`, `policy`, `redaction`. Status: `open` | `acked`.
3. Detail: `GET /alerts/{alertId}`. Render `kind`, `severity` (`warning` for authorization/replay, `critical` for policy/redaction), `action`, `resourceType` / `resourceId`, `correlationId`, `requestId`, `actorId`, `code`, `occurredAt`.
4. Ack: `POST /alerts/{id}/ack` `{}` with CSRF. Idempotent `200`. Viewer → `403`.
5. Correlate: optional `GET /audit-events?action=alert.{kind}&resourceId=` or jump to `GET /executions/{resourceId}` when `resourceType=execution`.
6. Never persist or display unexpected secret-shaped fields. If a field like `token` / `authorization` / `details` appears, strip it.

| Method | Path | Perm | CSRF | Notes |
| --- | --- | --- | --- | --- |
| `GET` | `/api/v1/alerts` | `alert.view` | no | `{items}`. Query `kind`, `status`, `resourceType`, `resourceId`, `limit` (1–100, default 50) |
| `GET` | `/api/v1/alerts/{alertId}` | `alert.view` | no | One row. Cross-workspace → `404` |
| `POST` | `/api/v1/alerts/{alertId}/ack` | `alert.ack` | yes | `{}` → updated row. Idempotent |

Alert JSON fields: `id`, `kind`, `severity`, `action?`, `resourceType?`, `resourceId?`, `correlationId?`, `requestId?`, `actorId?`, `outcome`, `code`, `acknowledgedAt?`, `acknowledgedBy?`, `occurredAt`. No `details` object.

Kinds emitted by the API (safe fixtures in tests):

| Kind | When | Typical `code` | `resourceType` |
| --- | --- | --- | --- |
| `authorization` | Authenticated member missing the requested permission; rejected job binding | `forbidden` | `workspace` / `job` |
| `replay` | Idempotency key reused with a different fingerprint | `conflict` | `execution` |
| `policy` | Dispatch policy decision is deny | `forbidden` | `workflow` |
| `redaction` | Artifact scan rejects unsafe content before persist | `invalid-request` | `execution` |

Out of scope: SIEM integrations, provider engines, `apps/web` rewrite.

RBAC: viewer can list/get/compare/export; editor can create/save/restore; publisher can publish; operator can start a pinned execution (not edit). `workflow.status` is `draft` until the first publish, then `published`. Slug defaults to `metadata.name` and stays stable; display `name` tracks the draft summary on save.

Every request receives `X-Request-ID`. A caller-supplied value is accepted only when it is 16–128 ASCII letters, digits, or hyphens; otherwise the API generates one. The same identifier is present on the response header, in `application/problem+json` as `request_id`, and in structured request logs so an API flow can be traced end to end.

Errors use `application/problem+json` and include `type`, `title`, `status`, `detail`, `instance`, `code`, and `request_id`. Documented codes:

| Code | Status | When |
| --- | --- | --- |
| `invalid-request` | 400 | Malformed JSON, missing body, or unsupported `Content-Type` |
| `invalid-workflow` | 400 | Workflow YAML failed parse/normalize/validation; `errors` lists path/line/column/code/message |
| `unauthenticated` | 401 | Missing or invalid credentials |
| `forbidden` | 403 | Authenticated caller is not authorized |
| `not-found` | 404 | Unknown path or missing tenant/workspace/user |
| `conflict` | 409 | Unique identity collision, last-admin protection, draft revision mismatch, duplicate published digest, idempotency fingerprint mismatch, fencing/lease mismatch, or a retry/cancel that is not allowed |
| `method-not-allowed` | 405 | Known path, unsupported method |
| `request-too-large` | 413 | Body exceeds 1048576 bytes |
| `internal-error` | 500 | Unexpected failure |
| `dependency-unavailable` | 503 | PostgreSQL is not reachable |

Foundation responses also set restrictive content, referrer, and permissions policies. When the request is HTTPS (direct TLS or `X-Forwarded-Proto: https` from a CIDR in `TRUSTED_PROXY_CIDRS`), responses also set `Strict-Transport-Security`. If `REQUIRE_TLS` is true, plain HTTP is rejected as `invalid-request`, except `GET /api/v1/health` and `GET /api/v1/readiness` so Kubernetes HTTP probes can reach the pod without Ingress TLS. Structured logs are JSON and secret-free: they record method, path, route, status, duration, bytes, and `request_id`, and never record `Authorization`, cookies, query strings, or request bodies. Session audit logs add `event_type`, `outcome`, `reason`, `user_id`, and `session_id` only. Metrics labels are method, route, and status only.
