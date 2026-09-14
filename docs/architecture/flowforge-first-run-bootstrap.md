# First-run operator wizard — bootstrap gate (B.1 / B.2 / B.3 / B.4)

Status: **B.1, B.2, B.3, and B.4 landed** (this page is the contract map for B.5–B.6). Parent epic [#333](https://github.com/bbengt1/flowforge/issues/333). B.1: [#334](https://github.com/bbengt1/flowforge/issues/334). B.2: [#335](https://github.com/bbengt1/flowforge/issues/335). B.3: [#336](https://github.com/bbengt1/flowforge/issues/336). B.4: [#337](https://github.com/bbengt1/flowforge/issues/337).

**Owners:** jonny (gate + B.2–B.5 APIs), Chloe (B.6 wizard chrome + Settings handoff). Product hard lines: Gracie.

**Baseline:** localseed lives at `apps/api/internal/localseed` (compose / trusted-dev). Sessions are `POST /embed/exchange` (production) or trusted-dev `POST /session`. Settings already hold session/health/OpenAPI.

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
| After wizard finishes (B.5 `MarkComplete`) | Same as complete | Product home; Settings for later edits |
| `/embed/v1` | **Do not call this endpoint to decide chrome.** Embed catalog / exchange / session stay ungated by bootstrap. | Never mount the wizard |

### Localseed / trusted-dev skip

Verified path: `apps/api/internal/localseed`. Compose `SEED_LOCAL_DEFAULTS` (on in `APP_ENV=development\|dev\|local\|test` when `REQUIRE_TLS` is false) seeds tenant `local`, workbench `default`, and `PLATFORM_ADMINS` as workspace admin.

After a successful `Apply` that created or reused those admins, localseed calls `bootstrap.MarkSeedSkip`:

- `persistence`, `firstAdmin`, `publicUrl` → ready
- `public_base_url` stored server-side (`PUBLIC_BASE_URL`, default `http://localhost:3000`)
- `complete=true`, `skipped=true`, `incomplete=false`
- `tls.ready` stays **false** on local HTTP (TLS is Settings-only after skip; ACME is deferred)

Production-locked processes never run localseed. `deploy/k8s` must not set `SEED_LOCAL_DEFAULTS` or a compose `PUBLIC_BASE_URL`.

### Already-bootstrapped (upgrade)

Migration `000024_instance_bootstrap.sql` inserts the singleton incomplete, then if `users` **and** `workspaces` already exist, marks `complete` + `skipped` + persistence/firstAdmin ready. Fresh empty databases stay incomplete.

Do **not** auto-complete at runtime when B.3 creates the first admin or B.4 stores the public URL — that would skip TLS. Only seed skip, migrate backfill, or B.5 `MarkComplete` flip the gate.

---

## 2. Status endpoint

`GET /api/v1/bootstrap`

OpenAPI: `apps/api/openapi/openapi.yaml` (`BootstrapStatus`). Same-origin web proxy: `GET /api/control-plane/bootstrap`, `POST /api/control-plane/bootstrap/persistence`, `POST /api/control-plane/bootstrap/admins`, and `POST /api/control-plane/bootstrap/public-url`.

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

`standaloneOnly` is always `true`. `tls.mode` (`none` \| `self_signed` \| `uploaded` \| `local_http`) may appear after B.5; it is never a key.

**Never present:** `publicBaseUrl` / `public_base_url`, passwords, hashes, KEK, PEMs, private keys, cookies, CSRF secrets.

### Chloe B.6 notes

1. Call `GET /api/control-plane/bootstrap` only from **standalone** shell (not `/embed/v1`).
2. `200` + `incomplete` → wizard. `200` + `complete` → product home (`/workflows`).
3. `401` → treat as complete (login / home). Do not invent a second gate.
4. `standaloneOnly` / this doc: ignore the payload on embed. Embed chrome stays ADV-021 (`GET /session` `session.embed`).
5. Step `ready` flags are progress only. **Fail closed:** do not skip ahead. B.2–B.5 mutations will reject out-of-order writes.
6. After `complete`, never remount the wizard. Link Settings for URL / TLS / users / persistence.
7. Do not store secrets, KEK, or this payload’s absence in `localStorage`.

---

## 3. B.2–B.4 landed; sketched B.5 API

B.2, B.3, and B.4 are implemented. B.5 shape stays locked so later stories do not invent it. All success bodies are **status-only** (`BootstrapStatus` or the same flags). Secrets POST once and are never echoed.

Prefix: `/api/v1/bootstrap/…`. CSRF on every cookie mutation (`X-CSRF-Token`). Incomplete installs: same unauthenticated-or-bootstrap-session rule as B.1 `GET /bootstrap` for B.2–B.4. B.5 may require that admin’s session. Embed sessions are `403` (wizard is standalone). Unauthenticated incomplete POSTs have no session, so CSRF does not apply until `ff_session` is present.

| Story | Method / path | Body (once) | Success | Notes |
| --- | --- | --- | --- | --- |
| **B.2 Persistence** (landed) | `POST /api/v1/bootstrap/persistence` | `{confirm:true}` only — **no DSN / password / `DATABASE_URL` in JSON** (process already uses `DATABASE_URL`) | `200` `BootstrapStatus`; `steps.persistence.ready=true` via `Store.SetStep` | Operator-facing check is a server-side PostgreSQL ping. Fail closed if PostgreSQL is not ready (`503`). Does not mark `complete`. Already `complete` → **`409 Conflict`** (Settings-only; not `404`). Same incomplete-install openness as B.1 GET. Same-origin proxy: `POST /api/control-plane/bootstrap/persistence`. |
| **B.3 First admin** (landed) | `POST /api/v1/bootstrap/admins` | `{issuer, external_subject, display_name?, password?}` — password POST once if local login lands; this release has **no local login**, so a non-empty `password` is **`400`** and is never stored. Prefer existing identity upsert (`localseed.ProvisionAdmin` / `UpsertUser`) | `201` `BootstrapStatus`; `steps.firstAdmin.ready=true` via `Store.SetStep` | Never return password / hash / KEK. Reject if persistence is not ready (**`409`** fail-closed order). Already `complete` → **`409 Conflict`** (Settings-only). Same incomplete-install openness as B.1/B.2. Embed sessions are `403`. CSRF required when `ff_session` is present. Grants workspace admin on the default localseed tenant/workbench (`local` / `default`). `platform.administer` remains the process `PLATFORM_ADMINS` allowlist (operators should include this `issuer\|subject`). Does **not** mark `complete`. Same-origin proxy: `POST /api/control-plane/bootstrap/admins`. |
| **B.4 Public URL** (landed) | `POST /api/v1/bootstrap/public-url` | `{publicBaseUrl}` — HTTPS preferred; HTTP is allowed for local (for example `http://localhost:3000`). Origin only: no userinfo, query, fragment, or path | `200` `BootstrapStatus`; `steps.publicUrl.ready=true` via `Store.SetPublicURL` | Persist on server (`instance_bootstrap.public_base_url`). **Do not echo the URL** on this response or `GET /bootstrap` (Settings read is later). Reject if first admin is not ready (**`409`** fail-closed order). Already `complete` → **`409 Conflict`** (Settings-only). Same incomplete-install openness as B.1–B.3. Embed sessions are `403`. CSRF required when `ff_session` is present. Does **not** mark `complete`. Same-origin proxy: `POST /api/control-plane/bootstrap/public-url`. |
| **B.5 TLS** | `POST /api/v1/bootstrap/tls` | `{action:"create-self-signed"}` **or** `{action:"upload", certPem, keyPem}` — PEM POST once | `200` status; `steps.tls.ready=true`; `tls.mode` | Never return key/PEM. ACME / Let’s Encrypt is **out of scope**. Then `MarkComplete`. Reject if public URL is not ready. |

Settings-only after complete: reuse these resources under `/api/v1/settings/…` (or document aliases in B.5). Wizard mutations reject with **`409 Conflict`** when `complete` is already true (B.2–B.4 landed this; B.5 must match).

Store methods already on `internal/bootstrap.Store` for those stories: `SetStep`, `SetPublicURL`, `SetTLS`, `MarkComplete`.

---

## 4. Persistence

Table `instance_bootstrap` (migration `000024_instance_bootstrap.sql`):

- Singleton `id='default'`
- Flags: `complete`, `skipped`, `persistence_ready`, `first_admin_ready`, `public_url_ready`, `tls_ready`
- Server-only: `public_base_url` (never in GET JSON), `tls_mode` (status enum)
- **No FORCE RLS** — instance substrate, like `browser_sessions`. `flowforge_app` SELECT/INSERT/UPDATE only. Not workspace-owned.

---

## 5. Non-goals (this epic)

- Full wizard UI (Chloe B.6)
- ACME / Let’s Encrypt
- Membership re-teach pages
- Changing YAML SoT or allowing drafts to run
- Gating embed catalog, exchange, or `/embed/v1` chrome
