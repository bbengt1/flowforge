# First-run operator wizard — bootstrap gate (B.1)

Status: **B.1 landed** (this page is the contract map for B.2–B.6). Parent epic [#333](https://github.com/bbengt1/flowforge/issues/333). This story: [#334](https://github.com/bbengt1/flowforge/issues/334).

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

Do **not** auto-complete at runtime when B.3 creates the first admin — that would skip URL/TLS. Only seed skip, migrate backfill, or B.5 `MarkComplete` flip the gate.

---

## 2. Status endpoint

`GET /api/v1/bootstrap`

OpenAPI: `apps/api/openapi/openapi.yaml` (`BootstrapStatus`). Same-origin web proxy: `GET /api/control-plane/bootstrap` (allowlisted in this PR).

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

## 3. Sketched B.2–B.5 APIs

These routes are **not implemented in B.1**. Shapes are locked so stories do not invent them. All success bodies are **status-only** (`BootstrapStatus` or the same flags). Secrets POST once and are never echoed.

Suggested prefix: `/api/v1/bootstrap/…`. CSRF on every cookie mutation (`X-CSRF-Token`). Incomplete installs: same unauthenticated-or-bootstrap-session rule as B.1 until first admin exists; after first admin, require that admin’s session. Embed sessions are `403` (wizard is standalone).

| Story | Method / path (sketch) | Body (once) | Success | Notes |
| --- | --- | --- | --- | --- |
| **B.2 Persistence** | `POST /api/v1/bootstrap/persistence` | `{confirm:true}` or operator-facing persistence check — **no DSN / password in JSON** (process already uses `DATABASE_URL`) | `200` status; `steps.persistence.ready=true` | Fail closed if PostgreSQL is not ready (`503`). Does not mark `complete`. |
| **B.3 First admin** | `POST /api/v1/bootstrap/admins` | `{issuer, external_subject, display_name?, password?}` — password POST once if local login lands; prefer existing identity upsert | `201` status; `steps.firstAdmin.ready=true` | Never return password / hash. Reject if persistence is not ready. `PLATFORM_ADMINS` / workspace admin. |
| **B.4 Public URL** | `POST /api/v1/bootstrap/public-url` | `{publicBaseUrl}` | `200` status; `steps.publicUrl.ready=true` | Persist on server (`instance_bootstrap.public_base_url`). **Do not echo the URL** on this status GET (Settings read is B.4/Settings). Reject if first admin is not ready. |
| **B.5 TLS** | `POST /api/v1/bootstrap/tls` | `{action:"create-self-signed"}` **or** `{action:"upload", certPem, keyPem}` — PEM POST once | `200` status; `steps.tls.ready=true`; `tls.mode` | Never return key/PEM. ACME / Let’s Encrypt is **out of scope**. Then `MarkComplete`. Reject if public URL is not ready. |

Settings-only after complete: reuse these resources under `/api/v1/settings/…` (or document aliases in B.2–B.5). Wizard handlers must `404`/`409` when `complete` is already true.

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
