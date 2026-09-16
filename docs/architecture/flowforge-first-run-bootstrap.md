# First-run operator wizard — bootstrap gate (B.1 / B.2 / B.3 / B.4 / B.5 / B.6 / B.7 / B.8)

Status: **B.1–B.8 landed** (this page is the contract map). Parent epic [#333](https://github.com/bbengt1/flowforge/issues/333). B.1: [#334](https://github.com/bbengt1/flowforge/issues/334). B.2: [#335](https://github.com/bbengt1/flowforge/issues/335). B.3: [#336](https://github.com/bbengt1/flowforge/issues/336). B.4: [#337](https://github.com/bbengt1/flowforge/issues/337). B.5: [#338](https://github.com/bbengt1/flowforge/issues/338). B.6: [#339](https://github.com/bbengt1/flowforge/issues/339) — **keep #339 open**. B.7: [#347](https://github.com/bbengt1/flowforge/issues/347) — **keep #347 open**. B.8: [#390](https://github.com/bbengt1/flowforge/issues/390) — **keep #390 open**.

**Owners:** jonny (gate + B.2–B.5 / B.7 APIs), Chloe (B.6 wizard chrome + Settings handoff; B.7 Skip chrome; B.8 non-prod defaults + TLS→https toast). Product hard lines: Gracie.

**Baseline:** localseed lives at `apps/api/internal/localseed` (compose / trusted-dev). Sessions are standalone `POST /login` (local email/username + password), `POST /embed/exchange` (embed), or trusted-dev `POST /session` (non-prod fail-closed). When `local_logins` is empty, first boot seeds a one-time `admin` / `admin` credential (`must_change_password`) — rotate via `POST /session/password`. That identity is **not** `PLATFORM_ADMINS`. Settings already hold session/health/OpenAPI.

---

## Hard lines (never weaken)

| Constraint | Rule |
| --- | --- |
| Standalone only | Wizard **never** gates or appears on `/embed/v1`. This status endpoint is not an embed router. |
| No secrets / KEK | Passwords, private keys, KEK, hashes, PEMs never enter browser, JSON responses, logs, or `localStorage`. |
| ADV-021 / ADV-024 | Embed chrome from `GET /session` `session.embed` only. Membership / isolation stay grant-gated. |
| Drafts never run | Wizard does not change publish-then-run. YAML `flowforge/v1` is unchanged. |
| After complete | Wizard never reappears. URL / TLS / users / persistence edits live in **Settings** only. |
| Fail-closed order | B.2–B.5 enforce persistence → first admin → public URL → TLS. B.1 only **exposes** state. |

---

## 1. Gate / skip rules

Server `instance_bootstrap` singleton (`complete` / `incomplete`).

| Situation | `GET /api/v1/bootstrap` | Chloe (standalone) |
| --- | --- | --- |
| Fresh install, no admin | `200` `{complete:false, incomplete:true, …}` **without** a session | Show wizard |
| Trusted-dev / compose localseed already created admin + public URL | `200` `{complete:true, incomplete:false, skipped:true}` **with** session or trusted-dev headers; unauthenticated is `401` | Product home (no re-teach) |
| Existing install (users + workspaces at migrate time) | Migration backfill sets `complete=true`, `skipped=true` | Product home |
| After wizard finishes (B.5 / B.7 `MarkComplete`) | Same as complete | Product home; Settings for later edits |
| `/embed/v1` | **Do not call this endpoint to decide chrome.** Embed catalog / exchange / session stay ungated by bootstrap. | Never mount the wizard |

### Localseed / trusted-dev skip

Verified path: `apps/api/internal/localseed`. Compose `SEED_LOCAL_DEFAULTS` (on in `APP_ENV=development\|dev\|local\|test` when `REQUIRE_TLS` is false) seeds tenant `local`, workbench `default`, and `PLATFORM_ADMINS` as workspace admin. Path-2 (`SEED_LOCAL_DEFAULTS=0`) skips that seed; B.3 `ProvisionAdmin` still create-or-binds the same `local` / `default` pair for the first admin (no demo credentials, does not mark complete).

After a successful `Apply` that created or reused those admins, localseed calls `bootstrap.MarkSeedSkip`:

- `persistence`, `firstAdmin`, `publicUrl` → ready
- `public_base_url` stored server-side (`PUBLIC_BASE_URL`, default `http://localhost:3000`)
- `complete=true`, `skipped=true`, `incomplete=false`
- `tls.ready` stays **false** on local HTTP (TLS is Settings-only after skip; ACME is deferred)

Production-locked processes never run localseed. `deploy/k8s` must not set `SEED_LOCAL_DEFAULTS` or a compose `PUBLIC_BASE_URL`.

### Already-bootstrapped (upgrade)

Migration `000024_instance_bootstrap.sql` inserts the singleton incomplete, then if `users` **and** `workspaces` already exist, marks `complete` + `skipped` + persistence/firstAdmin ready. Fresh empty databases stay incomplete.

Do **not** auto-complete at runtime when B.3 creates the first admin or B.4 stores the public URL — that would skip TLS. Only seed skip, migrate backfill, or B.5 / B.7 `MarkComplete` (create, upload, or `{action:"skip"}`) flip the gate.

---

## 2. Status endpoint

`GET /api/v1/bootstrap`

OpenAPI: `apps/api/openapi/openapi.yaml` (`BootstrapStatus`). Same-origin web proxy: `GET /api/control-plane/bootstrap`, `POST /api/control-plane/bootstrap/persistence`, `POST /api/control-plane/bootstrap/admins`, `POST /api/control-plane/bootstrap/public-url`, and `POST /api/control-plane/bootstrap/tls`.

### Auth

| Install state | Who may GET | Failure |
| --- | --- | --- |
| Incomplete (wizard in progress, no admin yet) | Unauthenticated. No bootstrap token. Matches `GET /health` / `GET /embed/catalog` (status-only, no secrets). | `503` if the store is down |
| Complete | Normal product auth: `ff_session` cookie, or trusted-dev identity headers when that flag is on. Same principal helper as `GET /session`. | `401` unauthenticated |

No anonymous scrape token. No KEK in a header. After complete, Chloe treats `401` as “go to login / product home,” never as “show wizard.”

### Response (status only)

```json
{
  "complete": false,
  "incomplete": true,
  "skipped": false,
  "standaloneOnly": true,
  "steps": {
    "persistence": { "ready": false },
    "firstAdmin": { "ready": false },
    "publicUrl": { "ready": false },
    "tls": { "ready": false }
  }
}
```

`standaloneOnly` is always `true`. After B.5 / B.7, `steps.tls.mode` is `self_signed`, `uploaded`, or `skipped` (omitted / `null` when unreadied). Localseed skip may leave TLS unreadied; `local_http` is reserved for that Settings path. It is never a key. Wizard skip (`skipped`) is not a permanent lockout — Settings `#tls` can enable create/upload later.

**Never present:** `publicBaseUrl` / `public_base_url`, passwords, hashes, KEK, PEMs, private keys, cookies, CSRF secrets.

### Chloe B.6 chrome (landed)

Adapter: `apps/web/src/lib/first-run-bootstrap.ts`. Gate: `BootstrapGate` on the standalone `WorkspaceShell` only. Wizard: `FirstRunWizard`. Settings handoff: `BootstrapSettings` (`/settings#bootstrap`).

1. Call `GET /api/control-plane/bootstrap` only from **standalone** shell (not `/embed/v1`).
2. `200` + `incomplete` → wizard. `200` + `complete` → product home (`/workflows`).
3. `GET` `401` → treat as complete (login / home). Do not invent a second gate. A **mutation** `401` while incomplete is a stale `ff_session` cookie (the GET is still anonymous-open). The Next proxy expires first-party and CHIPS `ff_session` / `ff_csrf` (`Path=/api/v1`) on that 401, and strips an unhydrated session cookie before the upstream call when the wizard POST has no `X-CSRF-Token`. Wizard POSTs are CSRF-exempt at the proxy so this does not depend on `POST /session/logout` or a readable `ff_csrf`. Retry the step once. Do not skip the wizard.
4. `standaloneOnly` / this doc: ignore the payload on embed. Embed chrome stays ADV-021 (`GET /session` `session.embed`).
5. Step `ready` flags are progress only. **Fail closed:** do not skip ahead. B.2–B.5 mutations will reject out-of-order writes.
6. After `complete`, never remount the wizard. Link Settings for URL / TLS / users / persistence (`/membership` for users).
7. Do not store secrets, KEK, or this payload’s absence in `localStorage`.

### Chloe B.7 Skip chrome (landed)

TLS step offers **Create self-signed** / **Upload PEM** / **Skip for now**. Skip is a first-class exit, not a silent default (create-self-signed stays selected until the operator chooses Skip). Loud copy: the instance stays on **HTTP until TLS is enabled in Settings**. Skip POSTs `{action:"skip"}` only — no PEM in the body, never `localStorage`. On success (`complete`) the wizard leaves for product home and never remounts. Settings `#bootstrap` / `#tls` surface `steps.tls.mode=skipped` and the path to enable create/upload later. Fail-closed order is unchanged: Skip is only offered when the TLS step is current (`publicUrl` ready). Never on `/embed/v1`.

### Chloe B.8 non-prod defaults + TLS→https toast (landed)

Incomplete **non-prod / path-2** chrome may pre-fill first-admin issuer `http://localhost`, subject `admin-1`, and public URL `http://localhost`. Fields stay editable. Persistence is unchanged. Production builds stay blank (fail-closed). Complete installs and localseed skip still do not remount the wizard.

The #376 one-time Login password stays orthogonal. Wizard chrome still does not collect, pre-fill, POST, or echo a password (B.3 `admin` is shorter than the stored-password minimum and is the Login seed only).

When the operator chooses **Create** or **Upload** (not Skip) and the remembered public URL is still `http://localhost` (or HTTP with hostname `localhost`, including a port), chrome re-POSTs `https://localhost` **while incomplete** (`SetPublicURL` already overwrites) and shows a loud toast: “Public URL set to https://localhost because TLS is enabled.” The toast stays mounted until it can be read; Sign in / workflows navigation is deferred. Skip does not rewrite. A non-localhost URL is never clobbered. Toast only if the URL actually changed. Never on `/embed/v1`. Never `localStorage`.

---

## 3. B.2–B.5 / B.7 landed API

B.2–B.5 and B.7 are implemented. All success bodies are **status-only** (`BootstrapStatus` or the same flags). Secrets POST once and are never echoed. **Chloe B.6 / B.7:** wizard chrome + Settings handoff + Skip-for-now consume these routes.

Prefix: `/api/v1/bootstrap/…`. CSRF on every cookie mutation (`X-CSRF-Token`). Incomplete installs: same unauthenticated-or-bootstrap-session rule as B.1 `GET /bootstrap` for B.2–B.5 / B.7. Embed sessions are `403` (wizard is standalone). Unauthenticated incomplete POSTs have no session, so CSRF does not apply until `ff_session` is present.

| Story | Method / path | Body (once) | Success | Notes |
| --- | --- | --- | --- | --- |
| **B.2 Persistence** (landed) | `POST /api/v1/bootstrap/persistence` | `{confirm:true}` only — **no DSN / password / `DATABASE_URL` in JSON** (process already uses `DATABASE_URL`) | `200` `BootstrapStatus`; `steps.persistence.ready=true` via `Store.SetStep` | Operator-facing check is a server-side PostgreSQL ping. Fail closed if PostgreSQL is not ready (`503`). Does not mark `complete`. Already `complete` → **`409 Conflict`** (Settings-only; not `404`). Same incomplete-install openness as B.1 GET. Same-origin proxy: `POST /api/control-plane/bootstrap/persistence`. |
| **B.3 First admin** (landed) | `POST /api/v1/bootstrap/admins` | `{issuer, external_subject, display_name?, password?}` — optional password POST once; stored only as a bcrypt hash for `POST /login` (identifier = `external_subject`). Omit password to create identity without a local-login credential. Prefer existing identity upsert (`localseed.ProvisionAdmin` / `UpsertUser`) | `201` `BootstrapStatus`; `steps.firstAdmin.ready=true` via `Store.SetStep` | Never return password / hash / KEK. Too-short password is **`400`** and is not stored. Reject if persistence is not ready (**`409`** fail-closed order). Already `complete` → **`409 Conflict`** (Settings-only). Same incomplete-install openness as B.1/B.2. Embed sessions are `403`. CSRF required when `ff_session` is present. Create-or-binds workspace admin on the default localseed tenant/workbench (`local` / `default`, created if missing so path-2 `SEED_LOCAL_DEFAULTS=0` still has a selectable workbench after `POST /login`). `platform.administer` remains the process `PLATFORM_ADMINS` allowlist (operators should include this `issuer\|subject`). Does **not** mark `complete`. Same-origin proxy: `POST /api/control-plane/bootstrap/admins`. |
| **B.4 Public URL** (landed) | `POST /api/v1/bootstrap/public-url` | `{publicBaseUrl}` — HTTPS preferred; HTTP is allowed for local (for example `http://localhost:3000`). Origin only: no userinfo, query, fragment, or path | `200` `BootstrapStatus`; `steps.publicUrl.ready=true` via `Store.SetPublicURL` | Persist on server (`instance_bootstrap.public_base_url`). **Do not echo the URL** on this response or `GET /bootstrap` (Settings read is later). Reject if first admin is not ready (**`409`** fail-closed order). Already `complete` → **`409 Conflict`** (Settings-only). Same incomplete-install openness as B.1–B.3. Embed sessions are `403`. CSRF required when `ff_session` is present. Does **not** mark `complete`. Same-origin proxy: `POST /api/control-plane/bootstrap/public-url`. |
| **B.5 TLS** (landed) | `POST /api/v1/bootstrap/tls` | `{action:"create-self-signed"}` **or** `{action:"upload", certPem, keyPem}` — PEM POST once | `200` `BootstrapStatus`; `steps.tls.ready=true`; `steps.tls.mode` (`self_signed` \| `uploaded`); then `Store.MarkComplete` so `complete=true` | Never return key/PEM/KEK. ACME / Let’s Encrypt is **out of scope** (`400`). Reject if public URL is not ready (**`409`** fail-closed order). Already `complete` → **`409 Conflict`** (Settings-only). Same incomplete-install openness as B.1–B.4. Embed sessions are `403`. CSRF required when `ff_session` is present. Materials are written to process `TLS_CERT_FILE` / `TLS_KEY_FILE` (`internal/tlsmaterial`, 0600, atomic replace). `instance_bootstrap` stores **status only** (`tls_ready`, `tls_mode`) — never the PEM. Missing/unwritable TLS paths → **`503`**. Same-origin proxy: `POST /api/control-plane/bootstrap/tls`. **This is the only wizard step that calls `MarkComplete`.** |
| **B.7 Skip TLS** (landed API + chrome) | `POST /api/v1/bootstrap/tls` | `{action:"skip"}` — no PEM/key | `200` `BootstrapStatus`; `steps.tls.ready=true`; `steps.tls.mode` `skipped`; then `Store.MarkComplete` so `complete=true` | Same fail-closed gates as B.5 (public URL ready, already complete → **`409`**, embed → **`403`**). Writes **no** PEM or key; never echoes secrets. Does **not** require `TLS_CERT_FILE` / `TLS_KEY_FILE`. Skip is not a permanent lockout — Settings `#tls` can enable create/upload later. ACME still out of scope. Top-level `skipped` stays false (that flag is localseed / migrate backfill only). Wizard chrome: **Skip for now** + loud HTTP-until-Settings copy. |

Settings-only after complete: wizard mutations reject with **`409 Conflict`** when `complete` is already true. Settings later reads `GET /bootstrap` `steps.tls.ready` / `steps.tls.mode` (and other step flags) — never files, PEMs, or `public_base_url`. Further TLS / URL / user / persistence edits live under Settings (no `/api/v1/settings/…` alias in this story).

Store methods: `SetStep`, `SetPublicURL`, `SetTLS`, `MarkComplete`. Private keys never enter `internal/bootstrap`.

---

## 4. Persistence

Table `instance_bootstrap` (migration `000024_instance_bootstrap.sql`; `tls_mode` `skipped` added in `000025_bootstrap_tls_skipped.sql`):

- Singleton `id='default'`
- Flags: `complete`, `skipped`, `persistence_ready`, `first_admin_ready`, `public_url_ready`, `tls_ready`
- Server-only: `public_base_url` (never in GET JSON), `tls_mode` (status enum)
- **No FORCE RLS** — instance substrate, like `browser_sessions`. `flowforge_app` SELECT/INSERT/UPDATE only. Not workspace-owned.
- **TLS files:** B.5 writes the certificate and private key to `TLS_CERT_FILE` / `TLS_KEY_FILE` (same pairing as `ListenAndServeTLS`). B.7 skip writes nothing and does not require the paths. The bootstrap table never stores PEMs. Operators mount a durable volume at those paths; a process restart picks up in-process TLS. Ingress-terminated installs still persist the pair there so Settings can later report status-only metadata (`steps.tls.mode`) without reading the key. Empty TLS paths fail closed (`503`) on create/upload — do not invent database storage or a process-internal fallback when env is unset. Local compose sets explicit `/tmp/flowforge-tls/{cert,key}.pem` on the existing `/tmp` tmpfs so path-2 wizard B.5 can write (UID 65532; `tlsmaterial` mkdir). Do not copy those localhost defaults into `deploy/k8s`.

---

## 5. Non-goals (this epic)

- ACME / Let’s Encrypt
- Membership re-teach pages
- Changing YAML SoT or allowing drafts to run
- Gating embed catalog, exchange, or `/embed/v1` chrome
- Post-complete Settings *mutation* APIs (status + link-out only in B.6)
