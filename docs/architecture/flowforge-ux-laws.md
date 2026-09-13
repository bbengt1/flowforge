# FlowForge UX Laws (post-R1–R7 polish)

Status: **docs-only design brief**. Does not change application code, contracts, or shipped behavior. Does **not** open GitHub issues.

**Catalog:** [Laws of UX](https://lawsofux.com/) (Jon Yablonski). Adopt **selectively** for chrome polish after rewrite epics R1–R7. Not a redesign of the security or product model.

**Owners:** Chloe (UI stories), Terry (verification after stories land). Product hard lines: Gracie. Epic cut: Arie. jonny only if a story discovers a real contract gap (expect none).

**Baseline:** landed [frontend UI](../reference/frontend-ui.md) after epic #195 and R2–R7; expanded surface map in [rewrite UI surfaces](../reference/rewrite-ui-surfaces.md); charter authority in [n8n-class parity](flowforge-rewrite-n8n-class-parity.md) §11.1.

---

## 1. Purpose

R1–R7 shipped n8n-class *interaction coverage* as original FlowForge chrome: canvas-first editor, remembered-open satellites, NDV conversation, one operate path, vault density, D2 activation, D5 test-run, embed after `session.embed`. The remaining work is **polish**, not another rewrite.

This brief uses Laws of UX to decide *what to tighten* and *what to leave alone*. It is not:

- a visual-identity or marketing refresh
- permission to clone n8n pixels, names, or IA
- permission to weaken YAML, publish-then-run, vault, ADV, or fail-closed catalogs
- an invitation to hide errors, run drafts, or bury grant-gated admin

**Hard lines (never weaken):**

| Constraint | Operator-visible rule |
| --- | --- |
| YAML `flowforge/v1` is source of truth | Canvas is a projection. Invalid YAML never guesses a graph. |
| Drafts never run | Publish (or D5 published test version) then start. |
| Vault | Display-name + UUID only. No KEK / secrets in UI chrome, YAML, or search. |
| ADV-021 | Chrome from `GET /session` `session.embed` only. Host query is display-only. |
| ADV-024 | Membership / isolation stay grant-gated. Isolation success is a **denial**. |
| One replay path | Editor overlay **or** `/executions/{id}` — not both graphs. Loud `indeterminate`. Fail-closed catalogs. |
| Not an n8n clone | Parity already shipped via R1–R7. This brief polishes FlowForge chrome. |

Prefer **already covered** over inventing work. A law that is satisfied by R1–R7 / ADV behavior is recorded as such and is not a story.

---

## 2. Adoption table

Every law from the source catalog. Classification:

- **Must** — adopt now; a real chrome gap remains after R1–R7
- **Should** — adopt when cheap / next polish pass
- **Already covered** — cite the R1–R7 / ADV behavior that satisfies it
- **Out of scope** — one-line why (conflicts with a hard line, or marketing-only)

| Law | Class | Stance |
| --- | --- | --- |
| **Cognitive Load** | **Must** | Top-bar verb pile and draft / published / test-version juggling still force extra working memory. Reduce chrome, do not hide the model. |
| **Hick’s Law** | **Must** | Save, Publish, Start published, Test run, and four satellites still read as peer choices. Progressive disclosure — not fewer capabilities. |
| **Fitts’s Law** | **Must** | Crowded top bar and icon-rail shrink the frequent targets (Save, Publish, Test run, canvas **+**). Enlarge and group; do not hide. |
| **Doherty Threshold** | **Must** | Optimistic pending/success/error is specified but uneven on save / publish / test-run / catalog. Perceived &lt;400ms **chrome** only — never skip fail-closed waits. |
| **Peak-End Rule** | **Must** | Operators remember the end of a run, decide, or test-run. Success, fail, waiting, and loud `indeterminate` must be the remembered peaks — not a quiet toast that looks like silent success. |
| **Serial Position Effect** | **Must** | First and last slots on the top bar and home row should be the 80% verbs/columns (identity + save/publish; activation + last run). |
| **Working Memory** | **Must** | Do not make operators hold “editing draft / published X is active / Test run mints a version” in their head. Persistent chrome, not a tooltip. |
| **Mental Model** | **Must** | FlowForge model (YAML projection, drafts never run, D2 compose, D5 test version) still leaks at empty states and Test run vs Start published. Teach it in chrome. |
| **Occam’s Razor** | **Must** | Trim redundant chrome (three home drawers vs first-class activation; extra peer verbs). Do not add a second replay, marketplace, or activation resource. |
| **Aesthetic-Usability Effect** | **Should** | Taste / density / spacing polish only. Never use “prettier” to hide errors, `indeterminate`, or grant-gated admin. Not security theater. |
| **Choice Overload** | **Should** | Enabled catalog + home filters can still dump options. Category-first and fewer default filters — when cheap. Hick covers the Must slice. |
| **Chunking** | **Should** | Inspector tabs and the Add action wizard already chunk. Remaining: top-bar groups and NDV last-run vs parameters. |
| **Goal-Gradient Effect** | **Should** | Wizard already ends on Review. Cheap win: Test run / publish / start show “next” without implying the draft is live. |
| **Law of Proximity** | **Should** | Group Save+Publish, Start+Test run, and Library+Inspector+YAML+Runs. Lands with the Hick/Fitts story. |
| **Paradox of the Active User** | **Should** | Operators will not read a manual. Empty home/canvas must teach create / import / template / **+** without Developer fixtures. |
| **Zeigarnik Effect** | **Should** | Unsaved already exists. Surface waiting / approval / indeterminate as unfinished work on home when cheap — do not invent a task product. |
| **Jakob’s Law** | **Already covered** | R2–R7 shipped a canvas-first workbench an automation operator already knows (home → graph → palette → inspector → runs → vault). Do **not** reopen this as an n8n clone brief. Remaining familiarity polish rides under Mental Model / Paradox empty states. |
| **Flow** | **Already covered** | Remembered-open Library / Inspector / Runs satellites (R2.1 / R2.2 / R4.2) and NDV add-credential (R5.3) keep the operator on the graph. |
| **Law of Common Region** | **Already covered** | Satellites, drawers, inspector tabs, and home list/cards already bound regions. UX.10 / R7.4: no nested `<main>`. |
| **Law of Prägnanz** | **Already covered** | Invalid YAML never guesses a graph. Node state is icon + text. Missing/invalid `metadata.ui.layout` → auto-layout (D1 / R2.5). |
| **Law of Similarity** | **Already covered** | Node-family marks, status badges, and fail-closed nav treat like with like. Color alone never means status. |
| **Law of Uniform Connectedness** | **Already covered** | Compatible-port edges, skip-to-failed / skip-to-indeterminate, overlay-on-this-canvas (R4.2). One connected operate path. |
| **Miller’s Law** | **Already covered** | Add action wizard (type → target/credential → configure → map → review) and inspector Triggers / Versions / Pins already keep lists inside 7±2. |
| **Pareto Principle** | **Already covered** | The 80% path is home → editor → save draft → publish → start / test-run. Do not add a second studio for the 20%. |
| **Selective Attention** | **Already covered** | Loud `indeterminate` (R4.4), skip-to-failed, failure-jumps-to-node (R4.3). Do not add more “attention” chrome that competes with those. |
| **Tesler’s Law** | **Already covered** | Publish-then-run, policy evaluate, vault, and ADV are irreducible. Chrome must expose them, not absorb them into “just run the draft.” |
| **Von Restorff Effect** | **Already covered** | `indeterminate` is the isolated status (icon + text + explanation). Isolation **success** is a denial (ADV-024 / R7.2) — do not restyle that as a friendly highlight. |
| **Postel’s Law** | **Out of scope** | Liberal-accept would guess invalid YAML, host query as authz, or disabled catalog types. Conflicts with fail-closed. Conservative-send (normalize, strip extras, UUID in YAML) is already the contract. |

---

## 3. Surface map

Must + Should laws only. One implication per surface. Surfaces: **Editor** (canvas / palette / top bar), **NDV**, **Runs** (inbox + overlay), **activation** (home + editor), **embed** `/embed/v1`, **credentials/vault**, **home** `/workflows`.

### Must

| Law | Surfaces | UX implication |
| --- | --- | --- |
| **Cognitive Load** | Editor top bar; NDV; activation; home | Fewer peer controls; one persistent “editing draft / published version is active” readout so operators do not reconstruct the model. |
| **Hick’s Law** | Editor top bar; palette | Group satellites vs authoring vs run verbs; category-first catalog — still the enabled catalog only. |
| **Fitts’s Law** | Editor top bar; canvas **+**; home row actions | Enlarge Save / Publish / Test run / **+**; do not shrink them to make room for taste chrome. |
| **Doherty Threshold** | Editor; NDV; Runs; vault; embed | Immediate pending/success/error on save, publish, test-run, catalog, and vault test. **Wait visibly** for `session.embed` and catalog 403 — do not guess. |
| **Peak-End Rule** | Runs overlay + inbox; NDV last-run; activation | End a start / test-run / decide / cancel on the overlay with loud `indeterminate` or jump-to-failed — never a quiet “ok” that could be silent success. |
| **Serial Position Effect** | Editor top bar; home list/cards | Lead with identity + save/publish; trail with Start published / Test run. Home: activation and last run at the scan ends. |
| **Working Memory** | Activation (editor + home); NDV; Test run | Label Test run as “publishes a test version, then starts it.” Unsaved buffer stays ineligible. Published pin stays visible. |
| **Mental Model** | Home empty state; empty canvas; activation; embed | Teach YAML-as-projection and drafts-never-run in empty states. Host `?tenant=` / `?workbench=` stay display-only copy, never identity. |
| **Occam’s Razor** | Home; Editor; Runs | Activation column is the activation path; drawers remain bookmarks, not a second lesson. One overlay, no `/replay`. |

### Should

| Law | Surfaces | UX implication |
| --- | --- | --- |
| **Aesthetic-Usability** | All listed surfaces | Align spacing, type, and satellite density. Never soften error / `indeterminate` / ADV-024 denial contrast to “look nicer.” |
| **Choice Overload** | Palette; home filters | Default fewer filters; category-first library. No marketplace, no disabled next/provider types. |
| **Chunking** | NDV; Editor top bar | Parameters / mapping / credentials / last-run as distinct chunks; top-bar groups as one visual chunk each. |
| **Goal-Gradient** | NDV wizard; activation | Review remains the last wizard step; Test run / publish show the next honest verb (start published version). |
| **Law of Proximity** | Editor top bar; home row | Related verbs sit together (save cluster, run cluster, satellite cluster). |
| **Paradox of the Active User** | Home; empty canvas; vault empty | First useful action on the page: create / import / template / add credential / canvas **+**. No Developer fixtures. |
| **Zeigarnik Effect** | Home; Runs inbox | Waiting / approval / unsaved read as unfinished. Do not invent a task inbox. |

---

## 4. Conflicts / non-goals

Where a law would tempt us to weaken a hard line, the hard line wins.

| Temptation | Why it fails | What we do instead |
| --- | --- | --- |
| **Doherty** vs fail-closed waits | Skipping `session.embed`, catalog 403, or invalid-YAML blocking to “feel fast” is an ADV / safety bug. | Optimistic chrome on *allowed* gestures. Visible wait + alert when the gate is the product. |
| **Aesthetic-Usability** vs loud `indeterminate` | Softening uncertain status into a pretty success state is silent success. | Taste polish around the existing icon + text + explanation. Never color-only, never quieter. |
| **Jakob’s Law** vs FlowForge mental model | Matching n8n’s “run the unsaved graph” / canvas triggers / branded NDV would clone and break D3 / D5 / drafts-never-run. | Workflow-*tool* familiarity (canvas, palette, inspector, runs). FlowForge verbs stay Save draft / Publish / Start published / Test run. |
| **Postel’s Law** (liberal accept) vs fail-closed | Guessing graphs, host-query authz, or extra catalog types is a contract bug. | Conservative send (normalize, strip, UUID refs). Reject the rest. |
| **Von Restorff / Selective Attention** vs ADV-024 | Highlighting membership/isolation as “special product chrome” pulls grant-gated admin back into the workbench. | Stay off product chrome (R7.2). Settings may link carefully. Isolation success remains a denial. |
| **Peak-End / Flow** vs one replay path | A second in-editor replay graph would feel “complete” and violate Gracie’s one operate path. | Overlay-on-this-canvas + **Open execution**. No `/replay`. |
| **Goal-Gradient / Hick** vs drafts never run | A single “Run” that starts the open buffer is the n8n-shaped shortcut we explicitly rejected (D5). | One-gesture Test run = mint published test version, then start. Unsaved stays blocked. |
| **Occam** vs Tesler | Deleting Publish because “one less verb” hides irreducible policy / digest / audit complexity. | Fewer *redundant* verbs. Keep Publish. |
| **Choice Overload** vs fail-closed catalog | Showing disabled next/provider types “so operators can browse” is a marketplace leak. | Enabled catalog only. `/actions` stays reference. |
| **Working Memory** vs vault | Showing fingerprint / plaintext “so they remember which secret” puts secrets in chrome. | Display-name + UUID only. Unexpected plaintext is strip + stop. |
| **Paradox of the Active User** vs grant-gated admin | Putting Membership on the nav “so they don’t need a manual” weakens ADV-024. | Omit from nav/search/Commands unless granted. |

**Non-goals for this brief**

- Screen-reader graph rewrite, mobile app, minimap/alignment as Musts (still aspirational in frontend-ui).
- Server-backed home search, folder API, template API, archive API (jonny extensions; not UX-Laws polish).
- Catalog fallback removal (R3.4) — contract hygiene, not a law.
- Visual-identity / marketing refresh.
- Creating GitHub issues from this page (Arie opens the epic).

---

## 5. Proposed story slices

Issue-ready for Arie. Chloe-led. Ordered. Effort **S** or **M**. jonny API: **none expected** — flag only if a story discovers a real gap.

Do not implement from this page. Each story is chrome-only on existing routes and verbs.

### UXL.1 — Top-bar verb chunking

**Laws:** Hick, Fitts, Serial Position, Occam, Cognitive Load, Proximity (Should).
**Surfaces:** Editor top bar (standalone + `/embed/v1`).
**Effort:** S.
**jonny:** none.

Acceptance:

- Authoring verbs (Save draft, Publish), run verbs (Start published, Test run), and satellites (Library, Inspector, YAML, Runs) read as **three groups**, not twelve peers.
- Serial position: identity / unsaved state leads; Start published + Test run trail. Save and Publish stay large, labeled, and visible — not overflow-only.
- Fitts: Save, Publish, Test run, and canvas **+** do not shrink below the current control height to make room for grouping.
- Undo/Redo stay available (R2.3). No verb removed. Drafts still never run. Publish remains last **saved** draft only.
- Same grouping on embed after `session.embed`. No second embed tree.

### UXL.2 — Draft / published / test-run working memory

**Laws:** Mental Model, Working Memory, Cognitive Load.
**Surfaces:** Editor top bar, Triggers tab, home activation column.
**Effort:** S.
**jonny:** none (D2 compose stays enable + version pin).

Acceptance:

- Persistent chrome states, in words: editing a **draft**; which **published** version is active (or “not active”); Test run copy names “publish a test version, then start it.”
- Unsaved buffer: Test run and Start published stay disabled or explain they need the last **saved** draft / a published version. No silent test of open YAML.
- Home activation column matches editor wording. Drafts never look live (R6.1 / R6.2 inherit).
- No new activation resource. No canvas trigger nodes.

### UXL.3 — Doherty-safe pending chrome

**Laws:** Doherty Threshold.
**Surfaces:** Editor, NDV, Runs, vault, embed `/embed/v1`.
**Effort:** S.
**jonny:** none. Do not add a websocket. Existing requests only.

Acceptance:

- Save draft, Publish, Test run, Start published, vault test/rotate, and catalog load show pending immediately, then success or error. Canvas stays interactive while those requests run (frontend-ui product principle).
- Fail-closed waits stay **visible waits**: missing `session.embed` is still an alert (ADV-021); catalog 403 / empty still fail closed; invalid YAML still does not draw a guessed graph.
- Host `?tenant=` / `?workbench=` remain display-only. No optimistic workspace switch from query params.
- No invented progress that claims a run succeeded when status is `indeterminate`.

### UXL.4 — Peak-end operate endings

**Laws:** Peak-End Rule (Selective Attention / Von Restorff already covered — do not regress).
**Surfaces:** Runs overlay, `/executions` inbox, NDV last-run, activation after Test run / Start published.
**Effort:** S.
**jonny:** none. No `/replay`. No server compare.

Acceptance:

- After Start published or Test run, the editor ends on the **Runs overlay** for that run (remembered-open satellite), not only a toast.
- Fail → jump to the node (R4.3 inherit). `indeterminate` stays icon + text + explanation on overlay **and** inbox. Waiting → decide stays on overlay and inbox (R4.5 inherit).
- Success ending is explicit and distinct from `indeterminate`. Cancel / retry / stop remain on the same path (R4.4 inherit).
- Inbox is not a second replay graph. **Open execution** still goes to `/executions/{id}`.

### UXL.5 — Home row scan order

**Laws:** Serial Position, Cognitive Load, Occam.
**Surfaces:** Home `/workflows` list + cards.
**Effort:** S.
**jonny:** none. No folder/search/archive API.

Acceptance:

- Scan ends prioritize **activation** and **last run** (plus waiting/indeterminate when already joined). Filters do not grow a fourth “activation drawer.”
- Home query drawers (`?start=`, `?webhooks=`, `?schedules=`) still work; they are not the activation lesson (R6.2 inherit).
- Row actions keep Open editor, Test run, Start published. Test run still mints a published test version (D5).
- No Developer fixtures on the home empty or populated list.

### UXL.6 — Empty states that teach the model

**Laws:** Mental Model, Paradox of the Active User (Should), Cognitive Load.
**Surfaces:** Home `/workflows`, empty canvas, vault `/credentials`.
**Effort:** S.
**jonny:** none. Templates remain client YAML that POST a draft.

Acceptance:

- Empty home: Create, Import YAML, or pick a reviewed template — each creates a **draft**. Copy says drafts do not run.
- Empty canvas: **+** / Add action is the add path. Does not send operators to `/actions` to place a node. Does not place triggers on the canvas.
- Empty vault: add via masked wizard; selectors stay display-name + UUID. No sample secrets.
- No starter/invalid YAML as primary buttons. Developer samples stay under Settings.

### UXL.7 — Palette category-first (enabled catalog only)

**Laws:** Hick, Choice Overload (Should), Chunking (Should).
**Surfaces:** Editor palette / Library satellite, Add action wizard step 1.
**Effort:** M.
**jonny:** none. Same `GET /workflows/catalog` (and engine catalogs). No marketplace.

Acceptance:

- First paint is **categories** (control flow, data, Kubernetes, SSH, scripts, HTTP/notifications as enabled). Search still reaches any enabled type.
- Recommended-from-upstream-port uses catalog port types / `allowedWith` only. Missing catalog → fail closed, no invented types.
- Triggers stay excluded (`rules.triggersAreWorkflowLevel`). Disabled / next / provider types stay hidden.
- `/actions` remains the reference, not a third app. Remembered-open satellite (R2.1) unchanged.

### UXL.8 — Aesthetic-Usability density pass

**Laws:** Aesthetic-Usability Effect (Should).
**Surfaces:** Editor, NDV, Runs, activation, embed, vault, home — after UXL.1–UXL.6.
**Effort:** S.
**jonny:** none.

Acceptance:

- Spacing, type, and satellite alignment are consistent across standalone and `/embed/v1`. No cloned n8n colors, icons, or measurements.
- Error, warning, `indeterminate`, and ADV-024 denial contrast do **not** get quieter. Status stays icon + text (UX.10 / R7.4 inherit).
- No new surfaces. No copy that calls isolation success a “pass.” No KEK / secret chrome.

---

## 6. Verification (Terry)

Check after the matching stories land. Secret-free evidence. Do not treat this page as permission to close R1–R7 issues.

| Must law | Terry checks |
| --- | --- |
| **Cognitive Load** | UXL.1 + UXL.2: an operator can state draft vs published-active vs test-run without opening YAML or three drawers. Top bar reads as three groups. |
| **Hick’s Law** | UXL.1 + UXL.7: satellites vs authoring vs run are visually grouped; palette is category-first; enabled catalog only; no extra peer buttons. |
| **Fitts’s Law** | UXL.1: Save, Publish, Test run, canvas **+** stay full-size and clickable on desktop editor and embed. Icon-rail collapse still leaves those targets on the top bar. |
| **Doherty Threshold** | UXL.3: pending appears immediately on save / publish / test-run / vault test. `/embed/v1` without `session.embed` is still an **alert** (not a guessed shell). Catalog 403 empties the library. Invalid YAML does not paint a graph. |
| **Peak-End Rule** | UXL.4: Test run / Start published lands on the overlay. Forced `indeterminate` (or existing fixture) is loud on overlay **and** inbox. Failure jumps to the node. Success ≠ indeterminate. No second graph. |
| **Serial Position Effect** | UXL.1 + UXL.5: top-bar lead = identity + save/publish; trail = start/test-run. Home list/cards put activation and last run at the scan ends. |
| **Working Memory** | UXL.2: Unsaved: Test run blocked or explained. Last saved draft: Test run copy mentions publishing a test version. Home column matches editor. No draft looks live. |
| **Mental Model** | UXL.2 + UXL.6: empty home/canvas/vault teach draft / **+** / no-run. Embed host query does not change workspace. Triggers still not on the canvas. |
| **Occam’s Razor** | UXL.1 + UXL.5: no new activation resource, no `/replay`, no fourth home drawer, no marketplace. Activation column remains the activation path. |

**Regression gates (all stories):** YAML round-trip unchanged; drafts never execute; vault metadata only; ADV-021 / ADV-024 unchanged; one operate path; loud `indeterminate`; fail-closed catalog; UX.10 / R7.4 Esc, focus return, single `<main>`, icon+text.

---

## Related documents

| Doc | Role vs this page |
| --- | --- |
| [n8n-class parity charter](flowforge-rewrite-n8n-class-parity.md) | Rewrite authority (D1–D6, R1–R7). This page is **post-rewrite polish**, not a new R-epic. |
| [Rewrite UI surfaces](../reference/rewrite-ui-surfaces.md) | Expanded today-vs-parity tables. Do not invent a second IA here. |
| [Frontend UI](../reference/frontend-ui.md) | Normative landed chrome + UX.10 / UX.11. Stories retarget; they do not replace this contract. |
| [Operator / admin UI](../guides/operator-admin.md) | Today’s walkthrough. Update when stories land — not in this PR. |
| [Embed SDK](../reference/embed-sdk.md) / [Portal adapter](../reference/portal-adapter.md) | Host contracts. ADV-021 / display-only query stay. |
| [Security model](../reference/security-model.md) | Trust boundaries. UX polish cannot move them. |
| [Laws of UX](https://lawsofux.com/) | External catalog. Product chrome says FlowForge, not the catalog’s branding. |
