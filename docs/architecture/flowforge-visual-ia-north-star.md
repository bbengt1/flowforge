# FlowForge visual + IA north star

Status: **docs-only architecture brief**. Does not change application code, contracts, or shipped behavior. Does **not** open GitHub issues.

**Sign-off:** Brent yes / no on this page. Chrome rebuild waits for yes. This is not permission to implement from the brief.

**Owners**

| Role | Who |
| --- | --- |
| Design (this north star) | **Gracie** |
| Product yes / no | **Brent** |
| Chrome after Brent yes | **Chloe** |
| Epic cut after Brent yes | **Arie** |
| Contracts | **jonny** only if a V-slice discovers a real contract gap (expect none) |
| Verification after stories land | **Terry** |
| Hard lines | Unchanged — [§3](#3-hard-lines) |

**Baseline on `main`:** E1–E12 + epic #195 + R1–R7 + UXL.1–UXL.8 + F.1–F.7 + O.1–O.4 + B.1–B.7. Interaction coverage and folder/Overview/bootstrap IA are already specified. The remaining gap is **visual language + chrome density**, not another product-model rewrite.

**Authority this page does not replace**

| Doc | Role |
| --- | --- |
| [n8n-class parity charter](flowforge-rewrite-n8n-class-parity.md) | Rewrite authority (D1–D6, R1–R7). n8n is **behavior / feature coverage only**. |
| [FlowForge UX Laws](flowforge-ux-laws.md) | Post-R1–R7 polish (Must / Should). This page is the **visual identity** successor, not a second law catalog. |
| [Workflows home folder hierarchy](flowforge-workflow-folders.md) | Nested folders, Unfiled, refuse-if-nonempty, move = `PATCH folderId` only, selected list non-recursive. |
| [First-run bootstrap](flowforge-first-run-bootstrap.md) | Standalone wizard only. Never `/embed/v1`. |
| [Frontend UI](../reference/frontend-ui.md) | Normative landed chrome. V-slices retarget visuals; they do not replace this contract. |
| [Rewrite UI surfaces](../reference/rewrite-ui-surfaces.md) | Today-vs-parity tables. Do not invent a second IA here. |

---

## 1. Status / owners

This brief is **Gracie’s design north star** for FlowForge chrome. It closes Brent’s visual-vision gap **without greenfielding APIs**.

| Gate | Rule |
| --- | --- |
| Until Brent yes | Docs only. No V-epic. No chrome PR. No Magic Patterns as a substitute for this brief. |
| After Brent yes | Arie opens V.1–V.n. Chloe implements chrome-only on existing routes. |
| jonny | Ping only if a slice cannot land on existing `/api/v1` + `GET /session`. Do not invent list/search/metrics APIs to “look finished.” |
| Terry | Secret-free evidence after each landed V-slice. Hard lines in [§3](#3-hard-lines) stay green. |

Do not implement from this page.

---

## 2. Problem statement

Brent’s call: **FlowForge is nowhere near his visual vision.**

That is not a contract problem. On `main` the product already has:

- YAML `flowforge/v1` as source of truth; canvas as projection
- Publish-then-run; drafts never execute; D2 activation; D5 test-run
- Vault display-name + UUID; ADV-021 / ADV-024
- One operate path; loud `indeterminate`; fail-closed catalogs
- Nested workspace folders (F.1–F.7): Unfiled virtual; refuse-if-nonempty; move = `PATCH folderId` only; selected list **non-recursive**
- Overview home (O.1–O.4): **card list primary** + compact Finder rail **filter-only**; path pills; stats / Personal / link-count **deferred**
- First-run wizard (B.1–B.7): persistence → admin → URL → TLS create / upload / skip; Settings after; `mode=skipped` loud HTTP-until-Settings
- Standalone and `/embed/v1` same chrome; wizard never on embed

What still fails the vision:

| Landed | Why it still looks wrong |
| --- | --- |
| Light operator shell (`#f6f5f1`, system UI, teal focus as an afterthought) | Reads as a stacked admin tool, not a dark workbench. |
| Overview cards on a light page | O.1–O.4 IA is correct; **surface treatment** is not. Cards do not yet match Brent’s attached Overview-style home lean (dark lifted rows, search/sort/filter, Create CTA, path pills). |
| UXL.8 density pass | Spacing/type alignment — not a visual identity. Aesthetic-Usability must not stay “slightly tidier cream.” |
| Config / Actions / Templates as peer nav | Correct capabilities; chrome still feels like several small apps. |
| n8n-class *behavior* already shipped | The team must not “finish the look” by cloning n8n pixels. |

**This page decides the visual + IA north star.** A later chrome rebuild (shadcn-friendly, tokens first) executes it. APIs, YAML, vault, ADV, and folder/Overview/bootstrap rules stay.

---

## 3. Hard lines

Never weaken. If a visual choice tempts a shortcut, the hard line wins.

| Constraint | Operator-visible rule |
| --- | --- |
| YAML `flowforge/v1` is source of truth | Canvas is a **projection**. Invalid YAML **never** guesses a graph. Folder membership is not in YAML. |
| Drafts never run | Publish (or D5 published test version) then start. Organizing or restyling a draft does not make it live. |
| Vault | **Display-name + UUID only.** No KEK / secrets in browser chrome, YAML, search, path pills, or cards. |
| ADV-021 | Embed chrome from `GET /session` `session.embed` **only**. Host query is **display-only**. Missing bind is an **alert**, not a guessed shell. |
| ADV-024 | Membership / isolation stay **grant-gated**. Isolation success is a **denial**. Denial contrast stays loud. |
| One replay path | Editor overlay **or** `/executions/{id}` — not both graphs. Loud `indeterminate`. Fail-closed catalogs. |
| Standalone = embed chrome | Same product tree. `/embed/v1` remaps hrefs after `session.embed`. **First-run wizard never on embed.** |
| Not a literal n8n clone | n8n is a **behavior / feature** reference only. **Never** a visual reference. No n8n colors, icons, measurements, names, or Overview-tab IA. |

Prefer **already specified** over inventing work. F / O / B / UXL / R stories stay; V-slices restyle them.

---

## 4. Reference apps (TAKE / SKIP)

**n8n is not a visual reference.** Cite it only as the existing behavior/coverage charter. Do not match its orange, card chrome, Overview tabs, or iconography.

**Home visual lean (attached):** Brent’s Overview-style screenshot (dark cards, search / sort / filter, Create CTA, folder/path pills). Use it as **density and arrangement**, not as a product to clone. Stats strip, Personal badge, pin-as-product, and link-count stay **out** (O.1–O.4).

Workflow / ops chrome **leads with Mobbin**. Public products stay as **backup** class references. Hard lines in [§3](#3-hard-lines) still win.

### Mobbin screen citations

Source: Mobbin paid plan, 2026-09-15 (`search_screens`, `platform=web`, `mode=deep`, `task_intent`: Flowforge visual IA north-star reference research). Every URL is a live `mobbin_url` from that brief — **none invented**. TAKE/SKIP is from the screen, not the app name.

| # | Surface | Screen | TAKE | SKIP |
| --- | --- | --- | --- | --- |
| 1 | **Home** | [Vapi — Workflows list](https://mobbin.com/screens/33f7fbe8-0b96-4dec-97de-0a0984187b2e) | Full-dark home; slim icon rail; teal **Create**; table (name, dates); secondary Upload JSON / Docs. | Ultra-sparse rows if last-run / activation must scan. Table-only as the *only* browse (Overview **cards** stay primary). |
| 2 | **Home** | [incident.io — Workflows](https://mobbin.com/screens/eb672c81-90ee-4b8b-970d-47de14a97241) | Labeled left-nav groups; ⌘K; **+ New workflow** placement. | **Light main pane** on a dark shell. Low metadata on rows. |
| 3 | **Home** | [Asana — Workflow canvas](https://mobbin.com/screens/75489bc8-85dc-45f7-bfb6-7268e9c52f74) | Dot-grid; dashed **+ Add** empty states. | 10+ horizontal tabs (chrome overload). |
| 4 | **Editor** | [Vapi — Squad canvas + inspector](https://mobbin.com/screens/16bbb954-fd24-4b49-8f21-b110a03a6c16) | **Three-pane** (nav \| canvas \| inspector); accent **selection ring**; inspector tabs; floating zoom / undo dock. | Assistant-specific tabs; cost/latency as required chrome; start-node as a trigger. |
| 5 | **Editor** | [Webflow — Flows](https://mobbin.com/screens/ed0176f0-e437-4d9d-bf52-153873c8cc71) | Left **Add blocks** palette; right Settings/Output; inline **+** on the spine; **Test / Publish** header. | Overly dense block grid — prefer a **searchable** list. Marketplace tiles. |
| 6 | **Editor** | [Weavy — canvas + palette](https://mobbin.com/screens/990421f6-789d-4be5-9b17-9e3fec19aa2f) | **Searchable** left palette; category chips; floating bottom canvas tools. | **Neon / rainbow** category colors. Missing right inspector. |
| 7 | **Editor** | [Runway — workflow canvas](https://mobbin.com/screens/034eb22c-a167-489c-8b1a-699f7e846442) | Max canvas; slim icon rail; dot grid; Save separate from run. | No persistent palette **and** inspector (too minimal). **Run** on unsaved. Credits-as-product. |
| 8 | **Editor** | [Lindy — Flow editor](https://mobbin.com/screens/0fb15b25-218d-4bf7-a712-6f31c0dbcdc8) | **Test vs Publish** header split; branch edge labels; orthogonal wires. | Floating Agent Builder covering the canvas — dock the inspector. Test that runs an unsaved buffer (D5 = mint published test version, then start). |
| 9 | **Editor** | [Railway — graph + Variables](https://mobbin.com/screens/6dedaaac-55c5-49b4-8a73-d31f5e15dfed) | Selected node → right drawer with tabs; masked `••••` inline; icon rail maximizes canvas. | Infra “Online / URL” chrome. Secrets as the inspector primary (display-name + UUID stays). |
| 10 | **Vault** | [Vapi — API Keys](https://mobbin.com/screens/2643a442-d170-4d50-9d50-7a06046c8027) | Group cards; **masked** values; adjacent **View / Copy / Delete**; scoped pills; per-group Add. | Credits FAB on the vault. Key material as list identity (list stays display-name + UUID). |
| 11 | **Vault** | [Copy.ai — API Keys](https://mobbin.com/screens/8c444549-4b1b-4425-bbc0-3e67726417c2) | Audit columns (created / last used / expires / status); **one-time reveal** + eye + copy. | **White modal** on a dark shell — use an elevated dark panel. |
| 12 | **Vault** | [Modal — Secrets](https://mobbin.com/screens/e11ade6b-7c86-4534-b83a-471f6f64263a) | Quiet Create; created / last-used columns; “credentials” subtitle. | List with **no** mask/copy. Promo banner. |
| 13 | **Runs** | [Vapi — Call Logs](https://mobbin.com/screens/ade375a8-2dcf-43cf-b00a-972495b2e3d0) | Status summary chips (All / Successful / Failed); filter-chip bar; high-contrast Fail; **Build vs Observe** nav split. | Call-domain columns. Inbox as a second replay graph. |
| 14 | **Runs** | [Databricks — Query History](https://mobbin.com/screens/da9a44b9-1634-4f2b-8378-04f1dfd29e80) | Leading **status icon**; duration + mini bar; dense filters; Editor vs History grouping. | Enterprise nav depth. Color-only status. |
| 15 | **Runs** | [Snowflake — Task History](https://mobbin.com/screens/5c191780-0a36-4707-a5ed-e248ce66c1e0) | Status pills; duration cues; previous-run squares. | Chart-as-home. PREVIEW noise. Wide column sprawl. Sparkline is **not** a home stats strip. |
| 16 | **Wizard** | [Higgsfield — 3 of 5](https://mobbin.com/screens/02e5ec2b-1406-4eb7-b1aa-cdd62a3b9b64) | Progress + **n of m**; one Continue; 3–5 steps. | Low-contrast disabled Continue. Use-case grid as FlowForge B-steps. |
| 17 | **Wizard** | [Vapi — use-case tiles](https://mobbin.com/screens/e8106529-4db7-4d84-971c-8d2dbda936d5) | Dark; step dots; Back + primary; accent selection ring. | >6 tiles on one step. Persona / “what are you using this for” as bootstrap (B-order stays persistence → admin → URL → TLS). |
| 18 | **Wizard** | [Figma — Dev Mode](https://mobbin.com/screens/68c2e030-6eac-46f0-9b0d-9aead62e27c1) | Numbered fail-closed rail; Next names the next step. | Light content pane. Remount after complete. |
| 19 | **Wizard** | [Modal — Welcome](https://mobbin.com/screens/a255484d-9fea-4ee4-a928-66d186219dee) | First-run over the shell; one accent CTA. | Many questions in one modal — **one decision per step**. Neon-for-its-own-sake. |
| 20 | **Wizard** | [Deel — org size](https://mobbin.com/screens/dbe85af1-ec59-464f-874e-c541236407f8) | One question per screen; pills; full-width progress; “Next step: …” preview. | Disabled Continue that blends into the footer. Personal-profile content. Embed. |

**Honorable (pattern support, not the top 20):** [Modal Deployment History](https://mobbin.com/screens/2988dfe5-56b1-46b2-a042-d9b73a8de152) · [Railway logs](https://mobbin.com/screens/3f38e15c-d2fe-4315-8262-3bd3dbb08d83) · [Vercel Deployments](https://mobbin.com/screens/e9576405-bcef-419a-922a-8fb84b044a54).

### Public products (backup)

IA/visual *class* only — not pixel specs. Use when a Mobbin screen is SKIP’d. No invented Mobbin URLs here.

| Reference | TAKE | SKIP |
| --- | --- | --- |
| **Brent Overview screenshot** (home lean) | Dark lifted **card rows**; header + **Create** as the primary verb; search + sort + filter on one row; **path pills** on the card; published/activation as a quiet badge; kebab for secondary verbs. | Stats / time-saved strip; Personal; pin count; orange CTA; tabbed “Workflows / Credentials / Executions / Variables / Data tables” as one Overview; n8n naming or orange. |
| **Linear** | Dark charcoal workbench; dense list scan; command palette as a power path; one accent on the active verb. | Issue-tracker IA as product home; cycle/project metaphors; turning `/workflows` into a task inbox. |
| **Notion** | Calm dark surfaces; breadcrumb / path as orientation; modest radius; type hierarchy that stays readable at density. | Block-editor as the canvas; pages-as-database as the folder model; marketing whitespace. |
| **Vercel Dashboard** | Project-card scan; search / sort; dark density; status as icon + label; Create is obvious without becoming a marketing hero. | Deploy-metrics as the home (no FlowForge stats until a metrics owner exists); team-plan chrome; marketplace tiles. |
| **macOS Finder** | Compact **disclosure** folder rail; path as orientation; select-a-folder filters the pane; keyboard move, not drag-only. | **Miller columns**; desktop-icon grid as primary browse; client-only trees; recursive “this folder and children” as the default list. |
| **Stripe Dashboard** | Operational table/card density; search + filter that do not hide fail-closed empty; errors and denials stay high contrast. | Finance IA; charts as the home; softening failures into “pretty empty.” |
| **Retool-class internal tools** | App-list → editor workbench; dark chrome; inspector + canvas as one product. | Builder-as-marketplace; drag-any-widget canvas; a second “studio” origin. |
| **n8n** | **Nothing visual.** Behavior/coverage only — already locked in the [parity charter](flowforge-rewrite-n8n-class-parity.md). | Colors, CSS, icons, NDV branding, Overview tabs, orange accent, “run the unsaved graph,” canvas triggers. |

### Mobbin anti-patterns (keep SKIP’d)

| Anti-pattern | Why it fails here |
| --- | --- |
| Mixed **light content** on a dark shell | Breaks full-dark north star (incident.io). |
| **White security modal** on dark chrome | Use an elevated dark panel (Copy.ai). |
| Floating AI / builder covering the canvas | Dock inspector (Lindy). |
| Editor with **neither** palette nor inspector | Config depth needs both (Runway minimal). |
| 10+ top tabs | Collapse into sidebar groups (Asana). |
| Vault list with no mask / copy | Secrets never plaintext in tables (Modal Secrets). |
| Promo banners / credit FABs on Vault or Observe | Keep those surfaces quiet. |
| Wizard with many questions or >6 tiles | One decision per step; B.1–B.7 stay 3–5 steps. |
| Low-contrast disabled Continue | Disabled must still read as a button. |
| Status by **color only** | Icon + text; loud `indeterminate`. |
| ID-hash as the row primary | Lead with workflow / run name. |
| **Rainbow** category chips | Icon + label; one accent for selection only. |
| **n8n visual clone** / marketplace | Hard line. Enabled catalog only. |

---

## 5. Visual language

Dark-first. One accent. Workbench density. Status is never color-only.

### Density

| Rule | Apply |
| --- | --- |
| Workbench, not marketing | Linear / Vercel / Databricks scan density. Cards or table rows — not hero tiles. Wizard stays low-density. |
| Home cards | One line of identity; one line of **status metadata** (updated / created / activation / last run); path pills; kebab. ~56–72px tall. Dense enough to scan; not Vapi-ultra-sparse. |
| Finder rail | Compact disclosure + folder icons. Filter-only. Not primary browse (O.1). |
| Editor | **Three-pane:** searchable palette \| dot-grid canvas \| inspector. Medium node spacing. Satellites are tools, not a second page. |
| Touch | Existing `max-width: 767px` breakpoint. Not a mobile app. Labeled verbs — do not icon-only the tree or Save / Publish. |

### Typography

| Rule | Apply |
| --- | --- |
| One UI sans | System stack or one licensed geometric (e.g. Geist / Inter). No display serif. No n8n-branded type. |
| Hierarchy | Page title (Overview / workflow name) is the only large line. Meta is smaller, lower contrast, still readable. |
| Mono | **Monospace only** for IDs, durations, hashes — never for display names. Tabular figures for timestamps. |
| Verbs | Sentence case. FlowForge verbs stay **Save draft / Publish / Start published / Test run / Create**. Header: max one solid primary + one–two ghost (Test, Import). |

### Color (dark-first charcoal + one accent)

| Token intent | Direction | Forbidden |
| --- | --- | --- |
| Canvas / page | Near-black charcoal (`#0B0D10`–`#12141A` candidate), not pure `#000` and not navy-blue “dashboard skin.” **Full dark** — no light content pane on a dark shell. | Light-first as the default. Cream `#f6f5f1` as the north-star canvas. Mixed light/dark product chrome. |
| Surfaces | Cards and rails **lift** one step (border + 1–2% lighter fill). | Heavy drop shadows; glassmorphism; white modals on dark. |
| **One FlowForge accent** | A single CTA / active-tab / focus / **selection ring**. Candidate: keep the current teal-family (`--focus-ring` `#0f766e`) as the **starting** accent so we do not invent a second brand in this PR. Gracie locks the hex after Brent yes. | **n8n orange / amber / coral.** **Neon rainbow** category chips. Accent-as-status. |
| Text | High-contrast primary; muted secondary for meta. WCAG on dark cards. | Grey-on-grey meta that fails contrast. |
| Danger / denial | Distinct from the accent. Isolation **success** stays a denial — never a friendly green “pass.” | Pretty-ing ADV-024. |

Light theme may exist later as a **follow** token map. It is not the north star.

### Spacing and radii

| Rule | Apply |
| --- | --- |
| Spacing | 4px base. Home header / filter row / card stack use a tight 8–16px rhythm. Do not add a 48px marketing gap to “look premium.” |
| Radii | Cards and inputs **8–12px**; nodes **6–10px**. Path pills may be fully rounded. Not pill-everything. |
| Borders | 1px hairline at ~white 8–12% opacity. Cards read as rows in a list, not floating islands. |

### Status semantics

| State | Treatment |
| --- | --- |
| All node / run / activation states | **Icon + text** (badge or dot + label). Color never the only signal (UX.10 / R7.4). |
| `indeterminate` | **Loud** — icon + text + explanation on overlay **and** inbox. Never a quiet toast that could be silent success. |
| Success vs indeterminate | Explicitly distinct. Peak-end success is focused/selected only. |
| Fail / waiting / approval | Jump-to-node / decide stay on the one operate path. |
| ADV-024 denial | High contrast. Isolation success is a **denial**, not a highlight. |
| Draft | Never looks live. Activation wording matches editor (`published vN is active` / `not active` / `Draft — not live`). |
| Catalog 403 / missing `session.embed` | Visible wait + alert. Do not guess a shell or invent types. |

---

## 6. Chrome rules

Same routes. Same verbs. New **look**. Standalone and `/embed/v1` share components.

### Shell

- **Full-dark** charcoal on every product route. No light content pane on a dark rail (incident.io SKIP). No second embed skin.
- Persistent workspace switcher (role + environment). Embed switcher stays **locked** to the exchanged workspace.
- Left nav: capability-gated from `GET /workspace`. **Labeled groups** — Build (Workflows, Actions, Templates, Config/targets), Observe (Executions, Approvals, Alerts), Vault-class (Credentials), Settings. Same routes; grouping is chrome only.
- Editor **collapses** to an icon-rail (Vapi / Railway / Runway) — original marks, not cloned icons. Labeled rail ~220–260px; icon rail ~48–56px.
- Membership / Isolation stay **off** product chrome (R7.2). Settings may link when granted.
- Search + Commands (Ctrl+Shift+K) stay. Never index secrets.
- Single `<main>`, skip `#main-content`, Esc / focus return on drawers.

### Home / Overview (`/workflows`)

- **Card list is primary browse** (O.1) — Brent Overview screenshot remains the home lean. A dense table with the **same status metadata** is an allowed alternate density, not a second home. Compact Finder rail is **filter-only**, non-recursive `?folderId=` (F.2 / O.1). Not Miller columns.
- Header: product title + **Create** (draft) as the one solid primary (Vapi / incident.io). Import YAML / template remain secondary, still POST a draft.
- One row: search (default **across folders**) + sort + filter. Optional “in this folder.”
- Cards (or table rows): name first; last updated / created; **path pills** from `GET /workflow-folders` ancestry (O.2); published / activation / last-run at the scan ends (UXL.5). Kebab. Unfiled has **no** path pills and is not a persisted folder. No live-toggle on a draft.
- Skip on cards: stats strip, Personal badge, link-count (O.1–O.4). No pin-as-product until a pin API exists. No marketplace / suggested-app grid.
- Empty home / empty folder / Unfiled-empty use **Overview card chrome** (O.3 / UXL.6) — dashed **+ Add** is fine. Drafts do not run. No Developer fixtures.
- Move = drag or **Move…** → `PATCH …/folder` `{folderId}` only. Refuse-if-nonempty delete. Viewers select-only.
- Same `WorkflowHome` on `/embed/v1/workflows` after `session.embed` (O.4 / F.7).

### Editor (`/workflows/{id}`)

- **Three-pane default:** searchable left palette (categories + search, Weavy / Webflow) \| dark dot-grid canvas \| right inspector (Params / I/O / Credentials / Advanced — FlowForge names, not branded NDV). Inspector ~280–320px.
- Nodes: family **shape + icon + label**; accent **selection ring**; clear ports. Optional branch-edge labels. Add via palette drag **and** canvas / spine **+**.
- Top bar: UXL.1 groups. Identity + unsaved + draft/published working memory (UXL.2). **Test run** vs **Publish** stay distinct (Webflow / Lindy). Save / Publish stay large. Runway’s unsaved **Run** is not the verb.
- Floating dock: select / pan / zoom / fit / undo (Vapi Squad). Do not hide Save / Publish into the dock.
- Library / YAML / Runs stay satellites. Category-first **enabled catalog only** (UXL.7). No rainbow category chips. No marketplace.
- Invalid YAML does not paint a guessed graph. Triggers stay workflow-level — do not TAKE start-nodes onto the canvas.
- After Start published / Test run → Runs overlay (UXL.4). No `/replay`. No floating builder that covers the graph.

### Vault (`/credentials`)

- List identity is **display-name + UUID** only. Group by type or a Type column. Audit: created / last used / expires / status (Copy.ai columns) — metadata, not secrets.
- **Always mask** in the list. **View / Copy** sit on create / rotate as a **one-time reveal**, then dismiss (Copy.ai, dark panel — not a white modal). After submit, chrome returns to display-name + UUID.
- Detail: test / rotate / usage / deletion-impact. Unexpected plaintext → strip + stop.
- **No KEK chrome.** No fingerprint-as-secret. No credits FAB. Empty vault: add, no sample secrets.
- NDV add returns to the graph. Dedicated routes remain.

### Executions

- Inbox `/executions` + detail `/{id}` stay the workspace operate path. Columns: status badge · run / workflow name · trigger · started · **duration** (± bar). Lead with the human name, not a hash.
- Summary **filter chips**: All / Succeeded / Failed / Running / waiting / `indeterminate` (Vapi Call Logs). Error rows may use a left accent bar — still icon + text.
- Editor overlay is the in-graph path. **Open execution** deep-links to detail — not a second inbox graph.
- Loud `indeterminate`. Cancel / retry / stop / decide on the same path.
- Compare stays client-side redacted. No second graph. No promo FAB. Duration cues stay; home stats strip stays out.

### Settings

- Session / health / OpenAPI / Developer samples stay here — not on home.
- After bootstrap **complete**, URL / TLS / users / persistence edits live in Settings only (`#bootstrap` / `#tls`).
- `steps.tls.mode=skipped` is **loud**: HTTP until TLS is enabled in Settings.
- Grant-gated admin links only when granted. Isolation success remains a denial.

### First-run wizard

- **Standalone shell only.** Never mount on `/embed/v1`. Do not call `GET /bootstrap` to decide embed chrome.
- Fail-closed order: persistence → first admin → public URL → TLS (create / upload / **Skip for now**).
- Skip is first-class, not a silent default. Loud HTTP-until-Settings. `{action:"skip"}` only — no PEM in `localStorage`.
- After `complete` or `401`, product home. Wizard never remounts.
- **3–5 steps** matching B.1–B.7 (persistence → first admin → public URL → TLS create / upload / skip). Progress bar or numbered rail; **one decision per step** (Deel / Higgsfield). Next may preview the following step.
- Full-dark + one accent. Back \| Continue (disabled still reads as a button). Dedicated full-screen or a dark modal over the empty shell — never a light pane, never `/embed/v1`.
- Not a marketing onboarding microsite. No use-case tile dump, no >6 tiles, no secrets / KEK in JSON or chrome.

---

## 7. Keep vs reshape

Chrome-only. Invariants **keep**. Visual treatment **reshape**. Do not replace routes.

| Surface | Keep | Reshape | Do not |
| --- | --- | --- | --- |
| **Shell** | Routes, RBAC nav, Commands, switcher, embed lock, ADV-024 off-chrome | Full-dark charcoal; **Build / Observe / Vault-class** labels; icon-rail collapse; one accent | Second embed tree; Membership on the nav; cloned icons; mixed light/dark |
| **Home / Overview** | `/workflows`; F.1–F.7; O.1–O.4; UXL.5–UXL.6; Create / Import / template → draft; `?folder=` / `?start=` / `?webhooks=` / `?schedules=` | Dark **cards** (Overview lean) or dense table with the same metadata; Create; search/sort/filter; path pills | Stats; Personal; Miller columns; tags-first; `/studio`; n8n Overview tabs; marketplace |
| **Editor** | YAML projection; D1 layout; D2/D5; UXL.1–UXL.4 / UXL.7; satellites; one overlay | Three-pane; searchable palette; Test vs Publish; floating zoom/undo; selection ring | Run draft; canvas triggers; branded “NDV”; `/replay`; guessed graphs; rainbow palette |
| **Vault** | Display-name + UUID; masked wizard; R5 routes | Dark list; mask; View/Copy **one-time reveal**; audit columns | KEK; plaintext in the list; secret search; white modal |
| **Executions** | Inbox + overlay; loud `indeterminate`; decide / cancel / retry / stop | Status badges; filter chips; duration cues | Second replay graph; silent success; color-only status |
| **Settings** | Health / OpenAPI / Developer / bootstrap handoff | Match shell tokens | Metrics dashboards; wizard remount |
| **Wizard** | B.1–B.7 order, skip semantics, standalone-only | Full-dark 3–5 steps; progress; one decision per step | Embed gate; ACME; secrets in chrome; light pane; use-case tile dump |
| **Actions / Templates / Config** | Existing routes; `/actions` is reference | Same tokens so they do not look like a second app | Marketplace; filing cabinet via `/actions` |
| **APIs / YAML / ADV** | All of [§3](#3-hard-lines) | — | Greenfield contracts “for the look” |

---

## 8. Design-system stance

| Decision | Rule |
| --- | --- |
| **Tokens first** | Color, type, radius, space, and status land as named tokens (CSS variables). Components consume tokens — no one-off hex in feature chrome after V.1. |
| **shadcn-friendly** | After Brent yes, Chloe may adopt shadcn primitives **mapped to FlowForge tokens**. shadcn is a component kit, not a second product look. Default shadcn zinc/orange skins are not the north star. |
| **No second app** | D6 stays locked: migrate `apps/web` in place. No `/studio`, no parallel package, no embed-only theme tree. |
| **One tree** | Standalone and `/embed/v1` share the token file and the same `WorkflowHome` / editor / vault / inbox components. |
| **a11y inherits** | UX.10 / R7.4: skip link, single `<main>`, Esc / focus return, icon+text, reduced motion. Visual rebuild must not regress them. |
| **UXL.8 successor** | UXL.8 was spacing/type alignment on the **current** light chrome. V-slices replace that chrome’s **identity**. Do not reopen UXL as a clone brief. |

---

## 9. Out of scope

Not this brief. Do not smuggle them into a V-slice “because the screenshot had it.”

| Out | Why |
| --- | --- |
| **Miller columns** | Finder rail stays compact disclosure + non-recursive filter (F.2 / O.1). |
| **Tags-first IA** | Folders are the organizer. Vault `tags` stay vault metadata. |
| **Stats / time-saved / runtime strip** | No metrics owner. O.1–O.4 already skipped. Home is not a dashboard. |
| **Personal badge / pin-as-product / link-count** | No pin or “personal workspace” API. Skip until Brent promotes a D. |
| **ACME / Let’s Encrypt** | B.5/B.7 stay create / upload / skip. Settings later. |
| **Marketplace / disabled catalog / `workflow.call`** | Enabled catalog only. `/actions` stays reference. |
| **Neon rainbow palettes / mixed light-dark chrome** | One accent; full-dark product surfaces. |
| **KEK / secret chrome** | Server-only. Unexpected plaintext is strip + stop. |
| **Greenfield APIs or a second UI package** | D6. jonny only on a real gap. |
| **n8n visual clone** | Hard line. |
| **Screen-reader graph rewrite / mobile app** | Still aspirational in frontend-ui. |
| **GitHub issues from this PR** | Arie opens V-epics **after** Brent yes. |

---

## 10. Proposed V.1–V.n (after Brent yes)

Issue-ready **shape** for Arie. Chloe-led. Chrome-only. Existing routes and verbs. **Do not implement from this page.**

Effort **S** or **M**. jonny: **none expected**.

### V.1 — Token foundation

**Surfaces:** global tokens (standalone + embed).
**Effort:** S.

Acceptance:

- Dark-first charcoal canvas, lifted surface, text, muted, **one** accent, danger/denial, focus ring.
- Type scale + 4px space + 8–12px radius documented in tokens and applied to the shell root.
- No n8n orange. No second theme tree. Light theme not required.
- Skip link, focus-visible, and contrast hold on dark cards.

### V.2 — Shell restyle

**Surfaces:** workspace nav, switcher, Commands, editor icon-rail.
**Effort:** S.
**Blocked by:** V.1.

Acceptance:

- Dark shell on every product route. Active item uses the one accent.
- Editor still collapses to an original icon-rail. Membership / Isolation stay off chrome.
- Embed: same shell after `session.embed`; missing bind is still an alert. Host query display-only.

### V.3 — Overview home visual rebuild

**Surfaces:** `/workflows`, `/embed/v1/workflows`.
**Effort:** M.
**Blocked by:** V.1; inherits F.1–F.7 + O.1–O.4.

Acceptance:

- Dark card rows; header + Create; search / sort / filter row; path pills; published/activation/last-run scan ends; kebab.
- Compact Finder rail stays filter-only / non-recursive. Unfiled has no pills.
- No stats, Personal, link-count, Miller columns, or n8n Overview tabs.
- Empty states stay UXL.6 / O.3. Move still `PATCH folderId` only. Same `WorkflowHome` on embed (O.4).

### V.4 — Editor chrome

**Surfaces:** `/workflows/{id}` + embed.
**Effort:** M.
**Blocked by:** V.1, V.2.

Acceptance:

- Dark canvas + satellite chrome. UXL.1–UXL.4 / UXL.7 grouping and working memory stay.
- Invalid YAML still does not guess a graph. Drafts still never run. One overlay. Loud `indeterminate`.
- Save / Publish / Test run / canvas **+** stay full-size.

### V.5 — Vault + executions restyle

**Surfaces:** `/credentials*`, `/executions*`, editor overlay (status paint only).
**Effort:** S.
**Blocked by:** V.1.

Acceptance:

- Dark find/detail and inbox density. Metadata only in the vault.
- Inbox is not a second replay graph. `indeterminate` stays loud (icon + text + explanation).
- No KEK chrome. No quieter denials.

### V.6 — Settings + first-run wizard

**Surfaces:** `/settings`, standalone wizard.
**Effort:** S.
**Blocked by:** V.1, V.2.

Acceptance:

- Same tokens as the product. Wizard never on `/embed/v1`.
- B.2–B.5 order unchanged. Skip stays loud HTTP-until-Settings. No remount after complete.
- No PEM / KEK / password in chrome or `localStorage`.

### V.7 — Status + embed visual gate

**Surfaces:** all listed; `/embed/v1` parity.
**Effort:** S.
**Blocked by:** V.2–V.6 as each lands.

Acceptance:

- Icon+text on every status. Success ≠ indeterminate. ADV-024 denial contrast holds.
- Standalone and embed match (spacing, type, cards, satellites). No second tree.
- Catalog 403 / missing `session.embed` still fail closed.

### Story table (Arie — after yes)

| ID | Slice | Owner | Blocked by | Effort |
| --- | --- | --- | --- | --- |
| V.1 | Token foundation | Chloe | Brent yes | S |
| V.2 | Shell restyle | Chloe | V.1 | S |
| V.3 | Overview home visual rebuild | Chloe | V.1, F/O landed | M |
| V.4 | Editor chrome | Chloe | V.1, V.2 | M |
| V.5 | Vault + executions restyle | Chloe | V.1 | S |
| V.6 | Settings + first-run wizard | Chloe | V.1, V.2 | S |
| V.7 | Status + embed visual gate | Chloe | V.2–V.6 | S |

---

## 11. Acceptance

**Brent yes** means: this visual + IA north star is the target; Arie may open V.1–V.n; Chloe may rebuild chrome against it.

**Brent no** means: revise this page. Do not start V-slices.

### Product acceptance (after V.1–V.7 land)

| Gate | Pass |
| --- | --- |
| Visual | Dark-first charcoal workbench; one FlowForge accent; Overview cards match the **lean** of the attached screenshot (not an n8n clone). |
| Home IA | Card list primary; Finder rail filter-only; path pills; no stats / Personal / Miller columns / tags-first. |
| Hard lines | [§3](#3-hard-lines) unchanged. YAML / drafts / vault / ADV-021 / ADV-024 / one replay / fail-closed catalog / standalone=embed / wizard-never-embed. |
| Verbs | Save draft / Publish / Start published / Test run / Create still mean the same things. |
| No second app | Same `apps/web` tree. Tokens + optional shadcn primitives. No `/studio`. |

### Terry (after matching stories)

Secret-free evidence. Do not treat this page as permission to close R / UXL / F / O / B issues.

| Gate | Terry checks |
| --- | --- |
| **YAML / drafts** | Restyle does not change `definitionYaml`, digest, or draft revision. Invalid YAML does not paint a graph. Drafts never run. |
| **Vault** | Display-name + UUID only. No KEK / secrets in cards, search, or pills. Unexpected plaintext still strip + stop. |
| **ADV-021** | `/embed/v1` without `session.embed` is an **alert**. Host `?tenant=` / `?workbench=` do not change workspace or folder load. |
| **ADV-024** | Membership / isolation stay off product chrome. Isolation success is a denial. Denial contrast is not quieter. |
| **Folders / Overview** | Non-recursive `?folderId=`; Unfiled virtual; refuse-if-nonempty; move = `PATCH folderId` only. No stats / Personal. |
| **Wizard** | Never on embed. Skip still loud HTTP-until-Settings. No remount after complete. |
| **Operate** | One overlay or `/executions/{id}`. Loud `indeterminate`. Fail-closed catalog. |
| **a11y** | Single `<main>`, skip link, Esc / focus return, icon+text, reduced motion. |

**Regression gates (all V-slices):** YAML round-trip unchanged; drafts never execute; vault metadata only; ADV-021 / ADV-024 unchanged; one operate path; fail-closed catalog; folders workspace-scoped; no cascade delete; no n8n visual clone.

### Optional Magic Patterns (after sign-off)

After **Brent yes**, Gracie / Chloe may prototype **Overview home** and **editor chrome** in Magic Patterns as a visual spike — tokens from V.1, IA from F/O/UXL, hard lines from [§3](#3-hard-lines).

| Rule | Apply |
| --- | --- |
| When | After yes. Not a substitute for this brief. |
| What | Dark Overview cards + Create + search/sort/filter + path pills; editor top bar + satellites on a dark canvas. |
| What not | Stats, Personal, Miller columns, n8n orange, embed wizard, KEK chrome, a second studio. |
| Landing | Prompts and editor links live in a later docs note or the V.3/V.4 story. Do not treat a prototype as shipped chrome. |

---

## Related documents

| Doc | Role vs this page |
| --- | --- |
| [n8n-class parity charter](flowforge-rewrite-n8n-class-parity.md) | Behavior/coverage authority. This page is **visual + IA identity**, not a new R-epic. |
| [FlowForge UX Laws](flowforge-ux-laws.md) | Interaction polish. V-slices succeed UXL.8’s *identity* gap. |
| [Workflows home folder hierarchy](flowforge-workflow-folders.md) | Folder IA. Visual rebuild must not change F semantics. |
| [First-run bootstrap](flowforge-first-run-bootstrap.md) | Wizard contract. V.6 restyles only. |
| [Frontend UI](../reference/frontend-ui.md) | Landed chrome. Update when V-slices land — not in this PR. |
| [Rewrite UI surfaces](../reference/rewrite-ui-surfaces.md) | Surface map. Do not invent a second IA. |
| [Architecture](../architecture.md) | Boundaries. Visual rebuild cannot move them. |
| [Security model](../reference/security-model.md) | Trust boundaries. Tokens cannot move them. |
| [Embed SDK](../reference/embed-sdk.md) / [Portal adapter](../reference/portal-adapter.md) | ADV-021, CHIPS, display-only host query stay. |
