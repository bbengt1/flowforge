# Workflows home: folder hierarchy

Status: **F.1 API + F.2–F.7 chrome landed** (this page remains the IA). Folder membership is not in YAML.

**Product ask (Brent):** `/workflows` should support a **folder hierarchy** so operators can organize flows visually in a UI-friendly tree — not by encoding paths into names.

**Owners:** Chloe (home / embed chrome), jonny (folder resource + additive list/move APIs), Terry (verification after stories land). Product hard lines: Gracie. Epic cut: Arie. This page is issue-ready for Arie; it is not permission to implement from the brief.

**Baseline:** `/workflows` is the product home (UX.8). Today, “folders” are a **client-side** name/slug prefix (`ops/…`, `ops: …`, or slug `ops--name`). Charter [§11.2](flowforge-rewrite-n8n-class-parity.md#112-jonny--control-plane--execution--credential-parity-gaps) left a first-class folder resource **out of scope until Brent promotes a D**. This brief **is that promotion**. Landed chrome: [frontend UI](../reference/frontend-ui.md), [rewrite UI surfaces](../reference/rewrite-ui-surfaces.md).

---

## Hard lines (never weaken)

| Constraint | Operator-visible rule |
| --- | --- |
| YAML `flowforge/v1` is source of truth | Canvas is a projection. Invalid YAML never guesses a graph. Folder membership is **not** in YAML. |
| Drafts never run | Publish (or D5 published test version) then start. Organizing a draft does not make it live. |
| Vault | Display-name + UUID only (ADV-021/024 stay). No KEK / secrets in folder names, search, or chrome. |
| ADV-021 | Embed chrome from `GET /session` `session.embed` only. Host query is display-only. |
| ADV-024 | Membership / isolation stay grant-gated. Isolation success is a **denial**. |
| No marketplace / `/actions` organizer | `/actions` stays catalog **reference**. Do not send operators there to file or find workflows. |
| Multi-tenant workbench | Folders are **per workspace** (server-derived tenant + workbench). Not global. Not a second tenancy axis. |
| Fail-closed RBAC | Folder read uses the same perm as listing workflows (`workflow.view`). Create / rename / delete / move uses the same perm as editing workflows (`workflow.edit`) or stricter. Nav and search never flash ungated folder verbs. |

---

## 1. Goal / non-goals

### Goal

Give `/workflows` a **nested folder tree** so a shared workbench can group workflows the way operators already think about them (team, environment, domain) — visually, durably, and identically in standalone and embed.

Success looks like:

- Left rail shows **this workspace’s** folders; the main pane lists workflows in the **selected** folder (or Unfiled).
- Create / rename / delete folders and move workflows without renaming slugs or YAML.
- Another operator on another device, and the same operator inside `/embed/v1/workflows`, sees the same tree.
- Prefix-in-the-name is no longer the primary organizer once the API exists.

### Non-goals

- **Tags** as the organizer (or a tags-first IA). Tags remain an optional later **Should**, not this epic.
- Changing `flowforge/v1`, draft/publish/run, or putting `folderId` in YAML / export documents.
- A marketplace, `/actions` filing cabinet, or a second home (`/studio`, `/projects`).
- Global or cross-workspace folders. Folders are not tenants, workbenches, or RBAC roles.
- Archive API, template API, or server-backed full-text search beyond folder-aware list/filter.
- Auto-migrating existing `ops/…` name prefixes into folders (optional later; do not block F.1–F.7).
- Per-operator private trees, starring, or “my folders” that diverge from the workspace tree.
- Folders for credentials, executions, templates, or `/actions`.

---

## 2. Decision: nested folders

**Locked.** Nested folders are the organizer. This is a tree, not a tag cloud and not a browser souvenir.

| Option | Verdict | Why |
| --- | --- | --- |
| **Nested folders (tree)** | **Adopt** | Matches the product ask. One parent, one place. Scannable left rail + breadcrumb + list. Familiar workbench IA without cloning another product’s pixels. |
| **Tags-first** (labels as the primary organizer) | **Reject for this epic** | Tags are many-to-many and do not give a visual hierarchy. They are an optional later Should. Do not design a tags IA “just in case.” Vault `tags` stay vault metadata; they are not this model. |
| **Client-only persistence** (`localStorage` / `sessionStorage` / prefix-in-name) | **Reject as primary** | Insufficient — see below. Prefix filters may remain as a **compat fallback** until F.2 ships, then retire from primary chrome. |
| **Join-table multi-home** (workflow in many folders) | **Reject** | That is tags. One workflow has at most one `folderId` (nullable = Unfiled). |

### Why chrome-only storage is insufficient

The tree must be a **server-backed folder resource**. Browser storage is not the source of truth.

| Failure if we persist only in chrome | What breaks |
| --- | --- |
| **Devices** | The same operator on laptop vs desktop sees different trees. Refresh / another browser is a reset. |
| **Shared workbench** | Operators in one workspace must file and find the same flows. A private local tree is a hidden second IA. |
| **Embed-safe** | `/embed/v1` runs in a host iframe with **CHIPS** partitioned cookies. `localStorage` is origin- and partition-scoped; Storage Access / unpartitioned cookies are forbidden. A tree that only exists in standalone `localStorage` disappears (or forks) in Portal. |
| **Tenancy** | Host `?tenant=` / `?workbench=` are display-only (ADV-021). A client-only tree keyed on query params would fake workspace identity. Server folders are RLS-scoped to the **exchanged** workspace. |
| **Prefix-in-name** | Today’s `ops/…` hack hides the slug, collides with display names, and is not shared structure — it is a filter over strings. |

Folders do **not** become a tenancy axis. `workspaceId` is always server-derived. Host-supplied `workspaceId` on write bodies stays `400`. Cross-workspace folder UUIDs stay `404`.

---

## 3. IA

`/workflows` stays the only home. Folders are a **rail + filter** on that list, not a new route family.

```text
+------------------+----------------------------------------------+
| Folder rail      | Breadcrumb: Unfiled | Ops / On-call          |
|                  |----------------------------------------------|
| Unfiled (12)     | [Search this folder ▾]  List | Cards         |
| ▾ Ops            |----------------------------------------------|
|    On-call       | name     activation   last run   …           |
|    Deploy        | …                                            |
| ▾ Platform       |                                              |
|    Ingress       |  (workflows in the selected folder only)     |
+------------------+----------------------------------------------+
```

### Left rail

- **Unfiled** — virtual row, not a persisted folder. Workflows with `folderId == null`. Always present.
- **Folder tree** — persisted folders for **this workspace only**. Expand/collapse is chrome state (may remember in `sessionStorage` as *view* state; the tree itself is server data).
- Selecting a row sets the main list. URL: additive query, e.g. `?folder=<id>` or `?folder=unfiled`. Deep links stay valid. Drop the param when the workspace/tenant+workbench changes.
- Counts (optional, Should): workflow count in that folder, not descendants.

### Breadcrumb

- Unfiled: `Unfiled`.
- Folder: `Parent / … / Current`. Each segment selects that folder.
- Do not show tenant/workbench in the crumb (switcher already does). Host query never appears as identity.

### Main list

- List + Cards stay. Columns stay activation + last run at the scan ends (UXL.5).
- **Selected folder only** — not recursive descendants. Nested work lives in child folders; search (F.6) is how you find across the tree.
- Create / import / duplicate / template still `POST` a **draft**. If a real folder is selected, the new workflow’s `folderId` is that folder. If Unfiled is selected (or none), `folderId` is null.
- Opening a row still goes to `/workflows/{id}` (same page under `/embed/v1`). The editor does not grow a second folder tree.

### Root vs Unfiled

- There is **no persisted root folder row**. The workspace *is* the root.
- Top-level folders have `parentId: null`.
- Unfiled is the bag of workflows with no folder — not “everything.” Do not add an “All workflows” default that hides the tree; search covers “all.”

### Depth

Recommend **maximum 4 folder levels** (top-level = depth 1; deepest leaf = depth 4). Enough for Team / Domain / Env / Slice. Deeper trees fail closed (`400`) on create/move. Unfiled does not count as a level.

### Narrow / touch

The rail stacks above the list at the existing `max-width: 767px` breakpoint (not a mobile app). Folder verbs stay labeled; do not icon-only the tree.

---

## 4. Interactions

All mutating gestures require `workflow.edit` (or stricter). Viewers (`workflow.view` only) see the tree and list; they do not get New folder, rename, delete, or Move.

### Create folder

- Rail **New folder** (or context menu on a folder / Unfiled).
- Name: trimmed display string, 1–64 graphemes, no `/` or control chars. Unique among **siblings** in the workspace (case-insensitive). Not a path.
- Parent = selected folder, or none (top-level) when Unfiled / nothing is selected. Creating under Unfiled creates a **top-level** folder (Unfiled is not a parent).
- Depth check server-side. Pending → success/error (UXL.3). CSRF + cookies as existing writes.

### Rename folder

- Inline or dialog. Same name rules. Does not rename workflows or slugs. Does not rewrite YAML.

### Delete folder

**Recommend: refuse if non-empty** (child folders **or** workflows in this folder).

- Empty folder → `DELETE` → `204`. Selection falls back to parent (or Unfiled).
- Non-empty → `409` with counts (`workflowCount`, `childFolderCount`). Chrome: explain “Move or delete contents first.” Delete stays disabled or errors loudly — no silent re-home.
- **Rejected alternative:** auto-move children to parent / Unfiled. Convenient, but a shared workbench would silently refile someone else’s flows. Fail-closed wins.

No cascade delete of workflows. Folder delete never publishes, archives, or runs anything.

### Move workflow

Two equivalent gestures; both call the same API:

1. **Drag/drop** a row (or multi-select, if already on the list) onto a folder or Unfiled.
2. **Move…** on the row menu: pick Unfiled or a folder (tree picker). Keyboard equivalent required (no drag-only).

Rules:

- One workflow → one folder or Unfiled (`folderId` null).
- Cross-workspace drop is impossible (tree is this workspace only).
- Move does not change YAML, slug, draft revision, or activation.
- Viewers cannot drag. Disabled drop targets do not imply success.

### Move folder (optional, same epic if cheap)

Re-parent a folder under another folder or to top-level. Server rejects cycles, depth > 4, and sibling name clashes. If this slips, F.3 can ship rename/delete without folder drag; workflows still move in F.4.

### Empty states

| State | Copy / verbs |
| --- | --- |
| **Empty home** (no workflows **and** no folders) | Existing UXL.6: Create, Import YAML, or a reviewed template — each creates a **draft**; copy says drafts do not run. Optional: New folder. No Developer fixtures. No `/actions` CTA. |
| **Empty folder** (folder exists, no workflows) | “Nothing in this folder.” Create draft **here** or Move existing. Delete folder only when there are also **no child folders** (same refuse-if-non-empty rule). |
| **Unfiled empty** (all workflows are filed, or none exist) | If workflows exist elsewhere: point at the tree + search. If none exist: same as empty home. |
| **Viewer, empty** | No create/move/delete. Do not fake an empty catalog as a permission grant. |

### Search behavior

| Mode | Default | Behavior |
| --- | --- | --- |
| **Across folders** | **Yes (F.6)** | Query matches workflow **name/slug** (existing client index is acceptable until jonny adds `q`; do not invent secret search). Results show a **folder path** column/crumb. Selecting a result opens the editor; a secondary control reveals the containing folder. |
| **Within selected folder** | Explicit constrain | A control (“in this folder”) limits to the selection. Unfiled + constrain = only unfiled matches. Does **not** include descendants unless we later add that as a Should. |
| **Folder names** | Should | Filter the rail as the operator types; do not hide Unfiled. |
| **Commands / global search** | Inherit | Ctrl+Shift+K still creates/opens workflows. Do not add a Commands detour that files via `/actions`. Unexpected secret fields stay stripped. |

Prefix-in-name filters (`ops/…`) remain until F.2; after F.2 they are compat-only and then leave primary chrome (charter “replace” row).

---

## 5. Contract sketch for jonny

Additive to existing `/api/v1/workflows` APIs. New folder collection; **nullable `folderId` on the workflow summary**. Do not put folders in `flowforge/v1`. Do not replace list/create/draft/publish.

JSON camelCase. Cookie session + `X-CSRF-Token` on POST/PATCH/DELETE. Host-supplied `id` / `workspaceId` / `workspace_id` on write bodies is `400`. Cross-workspace UUIDs are `404`. RFC 9457 problems.

### Folder resource

```text
Folder {
  id           uuid
  workspaceId  uuid          // server-derived; never accepted from the client
  parentId     uuid | null   // null = top-level
  name         string
  createdAt    time
  updatedAt    time
}
```

Persistence sketch (not a migration in this PR): `workflow_folders` with FORCE RLS, unique `(workspace_id, parent_id, lower(name))` (NULL parent treated as a sibling set), `depth` enforced in the write path, cycle check on parent change. Composite FK to `workspaces`. Index `(workspace_id, parent_id)`.

### Workflow ↔ folder

**Recommend: nullable `folderId` on `workflows`** (and on `GET /workflows` / `GET /workflows/{id}` summaries).

- `null` = Unfiled.
- One folder per workflow. No join table (that is tags).
- Not in YAML, drafts, versions, export, or compare.
- `POST /workflows` may accept optional `folderId`. Missing / null → Unfiled. Unknown / other-workspace → `404`. Depth/name rules do not apply to the workflow row.

### APIs (additive)

| Method | Path | Perm | Notes |
| --- | --- | --- | --- |
| `GET` | `/api/v1/workflow-folders` | `workflow.view` | `{items}` tree or flat list with `parentId`. This workspace only. |
| `POST` | `/api/v1/workflow-folders` | `workflow.edit` | `{name, parentId?}`. `201` folder. `409` sibling name. `400` depth / invalid name. |
| `GET` | `/api/v1/workflow-folders/{folderId}` | `workflow.view` | `200` or `404`. |
| `PATCH` | `/api/v1/workflow-folders/{folderId}` | `workflow.edit` | `{name?, parentId?}`. Rename and/or re-parent. `409` name or would-be cycle. `400` depth. |
| `DELETE` | `/api/v1/workflow-folders/{folderId}` | `workflow.edit` | `204` if empty. `409` if any child folder or workflow still references it. Never cascade-delete workflows. |
| `GET` | `/api/v1/workflows` | `workflow.view` | Additive query `folderId` (UUID) or `folderId=unfiled` (null). Omit = today’s full list (search / “across folders”). Each item includes `folderId`. |
| `PATCH` | `/api/v1/workflows/{workflowId}` | `workflow.edit` | Additive `{folderId}` (`null` or omit-with-explicit-null = Unfiled). **Move only** — do not overload this PATCH for YAML/name in this epic if a dedicated `PATCH …/folder` is cleaner. Either shape is fine; pick one and document it. `404` unknown folder. Does not bump `draftRevision`. |

No new execute / publish / catalog routes. Folder ops never start a run.

### Move / rename / delete semantics

| Op | Semantics |
| --- | --- |
| Rename | Metadata only. Sibling uniqueness. Audit `workflow_folder.rename`. |
| Re-parent folder | Cycle + depth + sibling name checks. Children (folders and workflows) stay with the moved node. |
| Delete folder | **Refuse if non-empty.** `409` + counts. Empty → delete row. Audit `workflow_folder.delete`. |
| Move workflow | Set `folderId`. Audit `workflow.folder.move` (from/to ids, no YAML). |

### Authz notes

| Action | Permission | Fail-closed |
| --- | --- | --- |
| List / get folders; list workflows by folder | `workflow.view` | Same as `GET /workflows`. Missing perm → `403`; chrome hides the rail verbs, not the fact that `/workflows` itself is gated. |
| Create / rename / re-parent / delete folder | `workflow.edit` | Same as creating/editing a workflow. Stricter is allowed; weaker is not. |
| Move workflow | `workflow.edit` | Same as edit. Viewer drag is a no-op in chrome and `403` on the API. |
| Embed | minted `session.embed.capabilities` | Cannot escalate. If embed session lacks `workflow.edit`, folder writes stay hidden/403. |

Do not invent `folder.admin`. Do not require `workspace.administer` (that would pull ADV-024 admin into home chrome). Isolation / membership stay grant-gated and off this rail.

RLS: every folder row and `workflows.folder_id` resolves to the same `workspace_id`. Application role never bypasses RLS.

### Additive rule

Existing clients that ignore `folderId` keep working: lists still return all workflows; create without `folderId` still Unfiled. Prefix filters in the UI are not an API contract.

---

## 6. Embed / ADV

Same IA under `/embed/v1/workflows`. **No second tree.**

| Rule | Apply |
| --- | --- |
| Mount | Product children are the canonical pages (R7.1). Folder rail + list + breadcrumb are the same components. |
| `session.embed` | Still required. Missing bind → alert, not a guessed shell (ADV-021). |
| Host query | `?tenant=` / `?workbench=` remain display-only. Folder selection uses `?folder=` on the embed path the same way; it is not workspace identity. |
| Capabilities | Hide New folder / Move / Delete when the minted set lacks `workflow.edit`. |
| Storage | Do not persist the tree in `localStorage`. `sessionStorage` may remember rail expand/collapse only, keyed off **exchanged** workspace id, dropped on workspace change. |
| Portal | `/portal/workflows` → iframe `/embed/v1` unchanged. Adapter / assertion / CHIPS unchanged. |
| ADV-024 | Membership / isolation stay off product chrome. Folder rail is not an admin surface. Isolation success remains a denial. |

Editor `/embed/v1/workflows/{id}` does not grow a filing rail. File from home; optional later Should: Move on the editor menu using the same PATCH.

---

## 7. Proposed stories (issue-ready for Arie)

Do not implement from this page. Arie opens the epic. Ordered. Chloe is blocked on F.1 for every UI slice that reads or writes folders.

### F.1 — Folder API (jonny)

**Owner:** jonny.
**Effort:** L.
**Blocked by:** nothing (Brent promotion).
**Blocks:** F.2–F.7.

Acceptance:

- `workflow_folders` (or equivalent) + nullable `workflows.folder_id`, FORCE RLS, unique sibling names, depth ≤ 4, cycle checks.
- Routes in §5 land under `/api/v1`. OpenAPI + [backend API map](../reference/backend-api-map.md) updated when this story ships (not in this PR).
- `GET /workflows` items include `folderId`; `folderId` / `unfiled` filter works. `POST /workflows` accepts optional `folderId`.
- Delete folder: `204` empty, `409` non-empty with counts. No cascade delete of workflows. No YAML change.
- Authz: view vs edit as §5. Host-supplied `workspaceId` → `400`. Cross-workspace folder id → `404`.
- Audit rows for create/rename/delete/move are secret-free. Drafts still never run.

### F.2 — Home folder rail + select (Chloe)

**Owner:** Chloe.
**Effort:** M.
**Blocked by:** F.1.

Acceptance:

- `/workflows` left rail: Unfiled + folder tree from `GET /workflow-folders`. Main list uses `GET /workflows?folderId=`.
- `?folder=` deep link. Workspace/tenant+workbench change drops previous-workspace folder state.
- List/Cards, activation + last run scan ends, home drawers (`?start=` / `?webhooks=` / `?schedules=`) unchanged.
- Prefix-in-name is no longer the primary organizer. Viewer can select folders; no mutate verbs.
- Single `<main>`, labeled rail, no nested main (UX.10 / R7.4).

### F.3 — Create / rename / delete folders

**Owner:** Chloe (API already in F.1).
**Effort:** M.
**Blocked by:** F.1; ships after or with F.2.

Acceptance:

- New folder / rename / delete on the rail. Name rules and sibling uniqueness errors are visible.
- Delete disabled or `409` when the folder has children or workflows. Empty delete returns to parent/Unfiled.
- Viewers: no those verbs. Pending → success/error. CSRF on writes.
- No `/actions` detour. No YAML / slug rewrite.

### F.4 — Move workflows (drag + menu)

**Owner:** Chloe.
**Effort:** M.
**Blocked by:** F.1, F.2.

Acceptance:

- Drag a workflow onto a folder or Unfiled **and** row-menu **Move…** (keyboard). Both call the F.1 move PATCH.
- Move does not change draft revision, YAML, or activation chrome.
- Viewer cannot drop. Cross-folder drop inside the workspace only.
- Multi-select move is a Should if list multi-select already exists; otherwise single-row is enough.

### F.5 — Empty states + Unfiled

**Owner:** Chloe.
**Effort:** S.
**Blocked by:** F.2 (F.3 for Delete on empty folder).

Acceptance:

- Empty home (no workflows, no folders): UXL.6 verbs + optional New folder. Drafts do not run. No Developer fixtures.
- Empty folder: create here / move / delete (only if no workflows **and** no child folders). Unfiled-empty points at the tree or empty-home verbs.
- Unfiled is always in the rail and is not a persisted folder.

### F.6 — Search / filter across folders

**Owner:** Chloe; jonny only if `GET /workflows?q=` is required (prefer client name/slug filter on the unfiltered list first).
**Effort:** M.
**Blocked by:** F.2.

Acceptance:

- Default search is **across folders**; results show folder path. Optional “in this folder.”
- Rail can filter folder names; Unfiled stays visible.
- No secret search. No marketplace. Commands do not file via `/actions`.
- If jonny adds `q`, it is additive and workspace-scoped.

### F.7 — Embed parity

**Owner:** Chloe.
**Effort:** S.
**Blocked by:** F.2–F.6 as each lands; can track embed in each story — this slice is the explicit parity gate.

Acceptance:

- `/embed/v1/workflows` shows the **same** rail + list + empty states + move after `session.embed`. No second tree.
- Missing `session.embed` is still an alert. Host query is display-only.
- Embed session without `workflow.edit` cannot mutate folders.
- CHIPS / Portal iframe: tree comes from the API, not `localStorage`.

### O.4 — Embed Overview parity

**Owner:** Chloe.
**Effort:** S.
**Blocked by:** O.1–O.3; F.7.

Acceptance:

- `/embed/v1/workflows` shows the **same** Overview cards + compact Finder rail after `session.embed`. No second tree. Prefer shared `WorkflowHome` — do not fork embed Overview.
- Missing `session.embed` is still an ADV-021 alert (fail-closed). Host `?tenant=` / `?workbench=` stay display-only.
- Viewers are select-only — no create / rename / delete / move without `workflow.edit`.
- CHIPS / Portal iframe: tree comes from `GET /workflow-folders`, not `localStorage`.
- Existing APIs only. No jonny change. Skip Personal / link-count / stats.

Keep #328 open.

---

### Story table (Arie)

| ID | Slice | Owner | Blocked by | Effort |
| --- | --- | --- | --- | --- |
| F.1 | Folder API (`workflow_folders` + `folderId` + list/move) | jonny | — | L |
| F.2 | Home folder rail + select | Chloe | F.1 | M |
| F.3 | Create / rename / delete folders | Chloe | F.1, F.2 | M |
| F.4 | Move workflows (drag + menu) | Chloe | F.1, F.2 | M |
| F.5 | Empty states + Unfiled | Chloe | F.2 | S |
| F.6 | Search / filter across folders | Chloe (jonny if `q`) | F.2 | M |
| F.7 | Embed parity | Chloe | F.2–F.6 | S |
| O.4 | Embed Overview parity | Chloe | O.1–O.3, F.7 | S |

---

## 8. Terry verify checklist

Check after the matching stories land. Secret-free evidence. Do not treat this page as permission to close R1–R7 or to ship without F.1.

| Gate | Terry checks |
| --- | --- |
| **YAML / drafts** | Moving or filing a workflow does not change `definitionYaml`, digest, or draft revision. Invalid YAML still does not paint a graph. Filed drafts still never run. |
| **Vault / ADV-021** | Folder names and search never show secrets or KEK. `/embed/v1/workflows` without `session.embed` is an **alert**, not a guessed tree. Host `?tenant=` / `?workbench=` do not change which folders load. |
| **ADV-024** | Folder rail is not on `/membership` or `/isolation`. Isolation success is still a denial. No grant-gated admin chrome on home. |
| **Tenancy** | Folders created in workspace A never appear in B. Cross-workspace folder UUID is `404`. Host-supplied `workspaceId` on folder writes is `400`. |
| **RBAC** | Viewer: tree + list, no New/Rename/Delete/Move (UI hidden; API `403`). Editor: those verbs work. Embed capabilities cannot escalate. |
| **Delete** | Non-empty folder delete is `409`; workflows still listed. Empty folder delete is `204`; workflows untouched. |
| **Unfiled** | New workflow without `folderId` appears in Unfiled. Move to Unfiled sets `folderId` null. Unfiled is not a row in `workflow_folders`. |
| **Depth / cycle** | Fifth-level create/move is `400`. Re-parent that would cycle is `409`/`400`. |
| **No second organizer** | `/actions` is still reference. No tags-first UI. No `localStorage` tree as source of truth. Standalone and embed show the same folders for the same workspace. |
| **Home inherit** | Activation + last run scan ends; `?start=` / `?webhooks=` / `?schedules=` still work; create/import/template still POST a draft. Single `<main>`, icon+text status. |

**Regression gates (all stories):** YAML round-trip unchanged; drafts never execute; vault metadata only; ADV-021 / ADV-024 unchanged; one operate path; fail-closed catalog; folders are workspace-scoped; delete folder never cascade-deletes workflows.

---

## Related documents

| Doc | Role vs this page |
| --- | --- |
| [n8n-class parity charter](flowforge-rewrite-n8n-class-parity.md) | Rewrite authority. §11.2 folder row was “out of scope until Brent promotes a D” — this brief is that D. |
| [Rewrite UI surfaces](../reference/rewrite-ui-surfaces.md) | Home still needs first-class folders; this page is the IA. |
| [Frontend UI](../reference/frontend-ui.md) | Normative landed home (prefix filters today). Update when F.2+ land — not in this PR. |
| [Operator / admin UI](../guides/operator-admin.md) | Today’s walkthrough (prefix folder filter). Update when stories land. |
| [Backend API map](../reference/backend-api-map.md) / [OpenAPI](../reference/openapi.md) | jonny updates with F.1. |
| [Database specification](../reference/database.md) | jonny adds `workflow_folders` + `workflows.folder_id` with F.1. |
| [Embed SDK](../reference/embed-sdk.md) / [Portal adapter](../reference/portal-adapter.md) | ADV-021, CHIPS, display-only host query stay. |
| [Security model](../reference/security-model.md) | Trust boundaries. Folders cannot move them. |
| [FlowForge UX Laws](flowforge-ux-laws.md) | Polish brief explicitly deferred the folder API; this epic is that extension. |
