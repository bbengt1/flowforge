# FlowForge web surface inventory (n8n-inspired UX)

Relates to an upcoming UX epic. **Analysis only** — no production UI
redesign in this document. Interaction-model reference is n8n’s editor
layout (canvas-first shell, left node library, right inspector,
executions drawer, credentials). This is **not** a 1:1 clone and must
not copy n8n assets, CSS, icons, or code.

Read with [frontend-ui.md](frontend-ui.md) (product IA) and current
`apps/web/src/app` + feature components. Confirm story slices after
Gracie’s keep/reshape lands.

Effort: **S** restyle/chrome only · **M** one-surface layout + reuse
clients · **L** new interaction chrome on existing APIs · **XL**
editor viewport rewrite (library overlay + inspector dock + YAML mode
+ executions drawer).

---

## Snapshot

FlowForge already has the *functions* of an n8n-like product (home,
canvas + YAML, wizard, vault, history/replay). The *feel* is still an
**operator stacked page**: epic banners, long contract prose,
`IsolationIdentityPanel` (session + tenant/workbench bootstrap) on
almost every route, and a long-scrolling editor that never takes the
viewport.

Typical n8n editor pattern (behavior only):

| Pattern | n8n-like | FlowForge today |
| --- | --- | --- |
| Product home | Overview → workflows list | `/` is a foundation landing; product home is `/workflows` |
| Editor chrome | Canvas fills the viewport; left nav collapses | Editor is a padded `max-w` page inside the always-on 256px shell |
| Add node | `+` / Tab / N overlay | Permanent 18rem library card + 5-step wizard |
| Inspector | Right dock / NDV on select | Right card column + validation; YAML always below canvas |
| Triggers | First **canvas nodes** | **Workflow-level** `spec.triggers` (keep) |
| Run | Execute current canvas | **Published version only** (keep) |
| Executions | Sidebar + in-editor list/drawer on the same canvas | Full pages `/executions` and `/executions/{id}` |
| Credentials | Overview list + create-from-node | Dedicated vault routes; inspector picks display names |

**Keep (do not n8n-clone):** YAML as source of truth (no persisted
canvas format); invalid YAML never guesses a graph; triggers stay
workflow-level; drafts never execute; vault never returns plaintext;
RBAC fail-closed nav; approval resume is `POST /approvals/{id}/decide`;
embed/Portal/CHIPS contracts.

**Reshape (UX epic):** operator chrome on product routes; `/` vs
workflow home; canvas-first editor; library overlay; YAML as a
mode/split; executions drawer; trigger/run panels off the long scroll.

---

## 1. App shell / nav / workspace chrome

**Effort: L**

### Routes / components

| Path | Role |
| --- | --- |
| `apps/web/src/app/layout.tsx` | Wraps all routes in `WorkspaceShell` |
| `/` | Foundation landing (`page.tsx`) — health + epic cards, not workflow home |
| `/settings` | Session/docs + links to membership/isolation/audit |
| `/embed` → `/embed/v1` | Embed mount (different chrome) |
| `/portal` → `/portal/workflows` | Portal host — **skips** the product shell |

Key components: `WorkspaceShell`, `WorkspaceNav`, `WorkspaceSwitcher`,
`GlobalSearch`, `CommandPalette`, `NotificationCenter`,
`SessionStatusChip`, `SessionExpiryBanner`, `WorkspaceProvider`.
Nav contract: `lib/workspace-nav.ts`. Search/palette:
`lib/workspace-search.ts`, `lib/command-palette.ts`.

### Current IA vs n8n-like

- Persistent **256px** left nav (hidden `< lg` behind Menu). Groups:
  **Authoring** (Workflows, Actions [placeholder “soon”], Credentials,
  Targets, Profiles, Config), **Operations** (Executions, Templates,
  Approvals, Alerts, Audit), **Workspace** (Settings, Membership,
  Isolation, Portal host). Fail-closed on `GET /workspace` permissions.
- Top bar: search, Commands (`Ctrl+Shift+K`), notifications, session
  chip. Switcher lives in the aside.
- Product pages still look like operators: uppercase epic eyebrow
  (`E6.1 · Chloe UI`), long contract copy, and
  `IsolationIdentityPanel` on home, editor, vault, executions,
  approvals, config, alerts, audit, templates, actions.
- Editor does **not** enter a canvas-first chrome mode.

n8n-like target: icon rail (or hidden aside) while editing; fat nav on
list surfaces; session bootstrap off the product canvas.

### What drives effort

Shell + embed + portal variants; every page header; moving identity
bootstrap to Settings / a first-run gate without breaking E2.3 cookie
+ CSRF + tenant/workbench. RBAC item visibility can stay.

### API / jonny

**No map change** for chrome. `GET /workspaces`, `GET /workspace`,
`GET|POST /session*` stay. Flag only if Gracie wants first-class
folders/projects in the switcher (today: tenant + `workbench_key`).

### Suggested story slices

- **UX-1 Product chrome: hide operator identity on product routes**
- **UX-2 Editor chrome mode: collapse left nav, drop epic banners**

---

## 2. Workflow list / home

**Effort: M**

### Routes / components

| Path | Role |
| --- | --- |
| `/workflows` | Product home — `WorkflowHome` (~1024 lines) |
| `/templates` | Same `TemplateGrid`; `POST /workflows` from static templates |
| `/actions` | Read-only catalog browser (`ActionCatalogPage` + `ActionLibrary`) |

Helpers: `lib/workflow-home.ts`, `lib/workflow-templates.ts`.
Query drawers on home: `?start=`, `?webhooks=`, `?schedules=`
(`ManualStartPanel`, `WebhookTriggerPanel`, `ScheduleTriggerPanel`).

### Current IA vs n8n-like

Already the closest “product” surface: list/card, client filters
(folder prefix `ops/…` or slug `ops--name`, tags-from-status, owner,
trigger, environment, status, last run, last modified), create /
import / duplicate / export, empty-state templates, Start / Webhooks /
Schedules / Open editor / Last run.

Gaps vs n8n Overview: `/` is not this page; identity panel + epic
header; trigger admin is a **home overlay** not an editor drawer;
folders/tags/archive are not API; last-run is N+1
`GET /workflows/{id}/executions?limit=1`; Actions nav is a
placeholder catalog page.

### What drives effort

Mostly restyle + make `/` redirect or promote `/workflows`; move
start/webhook/schedule into drawers. Filter logic can stay.

### API / jonny

**Flag if keep/reshape wants real folders, tags, archive, or a
template API.** None exist on main (documented in E6.1). Create/import
stay `POST /workflows`. No change needed for a visual pass.

### Suggested story slices

- **UX-3 Workflow home as the default landing**
- **UX-4 Compact workflow list (operator chrome off; trigger actions as drawers)**

---

## 3. Canvas + YAML sync + node wizard / library

**Effort: XL** (core of the makeover)

### Routes / components

| Path | Role |
| --- | --- |
| `/workflows/{id}` | Editor — `WorkflowOperator` (~1582 lines) |

| Piece | Path | ~Lines |
| --- | --- | --- |
| Canvas | `WorkflowCanvas.tsx` | 522 |
| YAML | `YamlEditor.tsx` | 144 |
| Library | `ActionLibrary.tsx` | 187 |
| Wizard | `ActionWizard.tsx` | 1956 |
| Inspector | `EditorInspector.tsx` + `NodeInspector.tsx` | 341 + 522 |
| Validation | `ValidationPanel.tsx` | 222 |
| Run / versions | `RunControl.tsx`, `VersionHistory.tsx` | 413 + 178 |
| Pins | `WorkflowConfigPins.tsx` | 155 |
| Editor list leftover | `WorkflowList.tsx` | 128 |

Graph/YAML helpers: `lib/workflow-graph.ts`,
`lib/workflow-action-library.ts`, `lib/workflow-action-wizard.ts`,
`lib/workflow-yaml-nodes.ts`. Catalog overlays: Kubernetes / SSH /
script / HTTP clients.

### Current IA vs n8n-like

The editor is a **vertical operator**: identity panel →
`WorkflowList` (create/select other workflows) → starter / invalid
YAML / import / validate / normalize / save / export → publish bar →
**xl 3-col** `[18rem library | canvas + YAML stacked | 20rem
inspector + validation]` → webhook + schedule cards → version history
+ run control → config pins → `ActionWizard` dialog.

Canvas today: pan, Ctrl+wheel zoom, select, output→input connect,
library drag-drop (defaults). **No** minimap, snap, multi-select,
undo/redo, alignment (IA lists them; not implemented). Positions are
auto-layout only — **not** a persisted UI format (keep).

Wizard steps (keep as guided path): type → target → configure →
connect → review. Library **Add** opens the wizard; drag still
inserts defaults (E6.2).

n8n-like target: full-viewport canvas; `+` overlay library; right
inspector on select; YAML as **Editor / YAML** toggle or split, not
always-on under the graph; save / publish / run in a top toolbar;
list/create/starter-YAML/debug buttons off the editor.

### What drives effort

`WorkflowOperator` is a god-component. Makeover means a new editor
shell, splitting run/version/trigger/pins into chrome or drawers, and
YAML mode without breaking normalize → `PUT …/draft` → replace
buffer. Canvas interaction upgrades (undo, multi-select) are
**additive** and should stay out of the first reshape unless Gracie
asks.

### API / jonny

**No map change** for layout. Existing loop stays:

- `GET /workflows/catalog` (+ engine catalogs)
- `POST /workflows/validate` (debounced)
- `POST /workflows/normalize` then `PUT /workflows/{id}/draft`
  (`If-Match` / revision; `409` reload)
- `POST /workflows/{id}/publish`
- `POST /workflows/{id}/compare`, restore, export

**Flag:** n8n-like “run the canvas I’m looking at” would need a
**test-version** (or equivalent) — frontend-ui already says drafts
never execute and a test run must mint an immutable version. Do not
invent `POST /executions`. Node-level execute would also be new.

### Suggested story slices

- **UX-5 Canvas-first editor shell (toolbar; strip stacked operator cards)**
- **UX-6 Node library overlay + right inspector dock**
- **UX-7 YAML as a mode/split (keep round-trip + fail-closed canvas)**
- **UX-8 Keep Add-action wizard; add quick-place from overlay**

Confirm with Gracie before UX-5 whether YAML stays first-class
(toggle) or becomes progressive disclosure.

---

## 4. Credentials vault

**Effort: M**

### Routes / components

| Path | Role |
| --- | --- |
| `/credentials` | List/filter — `CredentialVault` |
| `/credentials/new` | Catalog wizard — `CredentialWizard` |
| `/credentials/{id}` | Metadata, rotate, test, use, events, deletion-impact — `CredentialDetail` |

Also: `CredentialCard`, `SecretField`, `CredentialTestDialog`,
`DeleteImpactDialog`. Contract: `lib/credential-contract.ts`.
Editor pickers: `CredentialRefSelect` (display name only).

Types: `kubernetes`, `ssh_private_key`, `token`, `webhook_secret`,
`provider`.

### Current IA vs n8n-like

Same *job* as n8n credentials (workspace secrets, pick by name on a
node). Feel is operator: identity panel, `request_id`, stripped-secret
banners, full-page wizard/detail. n8n also **creates a credential
from the node picker** without leaving the editor.

Depth to **keep**: no plaintext after submit; deletion-impact;
fingerprint / last test; unexpected secret keys stripped.

### What drives effort

Visual pass + optional modal wizard + “create credential” from
inspector. Clients already exist.

### API / jonny

**No map change** for restyle or inspector-create (`POST /credentials`,
catalog, rotate/test/delete). Do not call isolation
`POST /workspace/credentials/{id}/use` as the product vault.

### Suggested story slices

- **UX-9 Vault list restyle (operator chrome off)**
- **UX-10 Create credential from the node inspector**

---

## 5. Executions history / replay / drawer patterns

**Effort: L** (drawer + reuse; keep full pages)

### Routes / components

| Path | Role |
| --- | --- |
| `/executions` | Workspace history — `ExecutionHistory` (~531) |
| `/executions/{id}` | Graph replay + cancel/retry/artifacts — `ExecutionDetail` (~1302) |

Replay: `ExecutionReplay` overlays step status on `WorkflowCanvas`
from pinned version YAML (`lib/execution-replay.ts`). Also:
`ExecutionCompare` (client-side redacted summaries),
`ExecutionArtifacts`, `RolloutObservationPanel`,
`ExecutionApprovalState`. History is a keyboard listbox (arrows /
Enter).

Run today: `RunControl` on the editor page; `ManualStartPanel` on
home (`?start=`) and history. Start is
`POST /workflows/{id}/executions` `{workflowVersionId, idempotencyKey,
input}` + `Idempotency-Key`.

### Current IA vs n8n-like

n8n: executions in the left nav **and** an in-editor list; opening a
run overlays I/O on the **same** canvas (NDV input/output).

FlowForge: replay is a **second route** with a second canvas. No
editor drawer. Compare is on the list/detail pages, not a map route.

**Keep:** published-only start; `indeterminate` icon+text; no blind
retry; cancel idempotent; resume = decide; secrets `[redacted]`.

### What drives effort

New sheet/drawer on `/workflows/{id}` reusing list + replay
components; editor toolbar “Executions”. Full `/executions` stays the
workspace inbox. Live node I/O in the inspector can use existing
`GET /executions/{id}` poll.

### API / jonny

**No blocking map change** for a drawer.

Already documented (not blocking):

- No execution-vs-execution compare route (client diffs summaries;
  same-workflow YAML still `POST /workflows/{id}/compare`)
- No replay projection endpoint (client: version YAML + steps)
- Last-run join is per-workflow `?limit=1`

**Flag** only if Gracie wants server-side exec-vs-exec compare, a
replay DTO, or workspace list cursors/filters beyond today’s
`workflowId` / `status` / `limit`.

### Suggested story slices

- **UX-11 Executions drawer on the editor (reuse history + replay)**
- **UX-12 Keep `/executions` as the workspace inbox (visual pass)**

---

## 6. Related ops (note only, lighter)

| Surface | Routes / components | vs n8n-like | Effort | Jonny? |
| --- | --- | --- | --- | --- |
| Approvals | `/approvals`, `/approvals/{id}` — `ApprovalList`, `ApprovalDetail`, `ApprovalDecideControls` | Extra vs n8n; inbox + decide. Linked from waiting executions | **S–M** visual; decide UX stays | No. Resume stays `POST …/decide`. Keep #108 semantics |
| Triggers | Home + editor panels; `?webhooks=` / `?schedules=` | n8n = canvas nodes. **Keep** workflow-level admin | **M** if moved into editor drawers (UX-4/UX-5) | No. `#113` / schedule map on main |
| Config / targets / profiles | `/config`, `/config?group=`, `/config/{kind}`, draft/publish/version pages — `ConfigHub`, `ConfigKindList`, `ConfigDraftEditor` | n8n has little of this (FF-specific pins) | **S** chrome only | No. Do not invent select/compare routes |
| Membership bootstrap | `/membership` — `MembershipOperator`, `IdentityBootstrap`, `MembersPanel` | Operator, not product shell | **S** — keep as Settings deep link | No |
| Isolation | `/isolation` — `IsolationExercise` | Negative operator; not product | **S** — keep hidden (ADV-024) | No |
| Alerts / audit | `/alerts`, `/alerts/{id}`, `/audit` | Ops extras | **S** chrome | No. Identifiers only |
| Templates | `/templates` | n8n has a richer gallery | **S** unless a template API appears | **Flag** if catalog becomes server-side |
| Embed / Portal | `/embed/v1`, `/portal/workflows` | Host chrome | Out of epic unless editor chrome leaks | No. E11 contracts stay |

---

## Dependency map (Chloe ↔ Gracie ↔ jonny)

```text
Gracie keep/reshape
  → which chrome dies (identity panel, epic banners, / landing)
  → YAML first-class vs progressive
  → triggers stay workflow-level (recommended keep)
  → execute published-only vs test-version (jonny if changed)
      ↓
Chloe story slices UX-1 … UX-12
      ↓
jonny only if Gracie asks for:
  folders/tags/archive/template API
  test-version / node-level execute
  exec-vs-exec compare or replay projection
```

`apps/api` is unchanged for a visual/IA makeover that reuses current
clients.

---

## Chloe paste list (Flowforge group)

Confirm after Gracie’s keep/reshape. Titles only:

1. **UX-1 Product chrome: hide operator identity on product routes**
2. **UX-2 Editor chrome mode: collapse left nav, drop epic banners**
3. **UX-3 Workflow home as the default landing**
4. **UX-4 Compact workflow list (trigger actions as drawers)**
5. **UX-5 Canvas-first editor shell (toolbar; strip stacked operator cards)**
6. **UX-6 Node library overlay + right inspector dock**
7. **UX-7 YAML as a mode/split (keep round-trip + fail-closed canvas)**
8. **UX-8 Keep Add-action wizard; add quick-place from overlay**
9. **UX-9 Vault list restyle (operator chrome off)**
10. **UX-10 Create credential from the node inspector**
11. **UX-11 Executions drawer on the editor (reuse history + replay)**
12. **UX-12 Keep `/executions` as the workspace inbox (visual pass)**

Optional later (not the makeover): canvas undo/multi-select/minimap;
wizard/palette focus trap; touch inspector-first (already in
[e12-accessibility-review.md](e12-accessibility-review.md)).

---

## Out of scope for this inventory

- No production UI implementation
- No n8n code/CSS/icon/branding copy
- Do not close issues
