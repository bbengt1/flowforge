# E12.3 accessibility review

Relates to #184 / Part of #181. **Keep #184 open.**

Chloe review of primary operator/admin surfaces in `apps/web` before
production approval. Scope is **docs + cheap, high-value fixes**
(labels, focus, contrast, keyboard paths). Not a redesign and not a
full WCAG audit of every foundation operator.

Operator procedures: [operator-admin UI guide](../guides/operator-admin.md).
Ops landing: [operations/index.md](../operations/index.md).
Product a11y principles: [Frontend UI](frontend-ui.md#accessibility-and-responsive-behavior).
Jonny owns API/OpenAPI, deploy, incident, backup, and the threat-model
half of E12.3 — this file does not duplicate those.

Evidence is secret-free.

## Surfaces reviewed

| Surface | Route / component | Keyboard / SR notes |
| --- | --- | --- |
| Workspace shell | `WorkspaceShell`, `WorkspaceNav`, `WorkspaceSwitcher` | Skip link → `#main-content`. Pages already ship `<main>` + `<h1>` — the shell does not nest a second `main`. Mobile Menu has `aria-expanded` / `aria-controls`. Nav `aria-current="page"`. |
| Search | `GlobalSearch` | Labeled combobox + `listbox` / `option`. Secrets never indexed. |
| Command palette | `CommandPalette` | Ctrl+Shift+K. Labeled filter, listbox + highlight, Esc restores focus to Commands. |
| Session chrome | `SessionStatusChip`, `SessionExpiryBanner` | Accessible chip name; stale/expired are `role="alert"`; warning stays `status`. |
| Workflow home | `/workflows` · `WorkflowHome` | Page `h1`. Filters labeled. List/Cards `aria-pressed`. Import input `sr-only`. |
| Authoring | `/workflows/{id}` · canvas, YAML, wizard, validation | Canvas `role="application"` + node/edge labels. YAML `htmlFor`. Validation `aria-live`. Wizard dialog + Esc. UX.10: labeled editor bar; library / YAML / runs / (narrow) inspector Esc closes + focus return; selection `status` announcement. UX.11: last-run I/O is redacted; `indeterminate` stays icon+text in the inspector. R7.4 / #279 — **Keep #279 open.**: same Esc / focus return / no nested `<main>` / icon+text contract on NDV, palette, Runs overlay, activation chrome, and other R2–R6 satellites. Still no SR graph rewrite. |
| Credentials | `/credentials` · vault, wizard, `SecretField` | Labeled filters. Secret fields described; never plaintext in list. |
| Executions | `/executions` · `ExecutionHistory` | Focusable listbox, Arrow/Enter, status icon + `sr-only` description. Skip-to-error links on detail. |
| Approvals | `/approvals` | Labeled filters. Expired banner `alert`; decide disabled. |
| Embed chrome | `/embed/v1` · `EmbedChrome` | Same skip target. Gated nav. Missing `session.embed` is `alert`. |
| Membership / isolation | `/membership`, `/isolation` | Hidden unless ADV-024 grant. Tables have captions / `sr-only` granted text. |

## Fixes applied (this PR)

Cheap changes in `apps/web` — no product-behavior rewrite.

1. **Skip link + visible `:focus-visible` + `prefers-reduced-motion`**
   (`globals.css`, `WorkspaceShell`).
2. **Mobile nav** — `aria-controls="workspace-nav"` and an explicit
   open/close name on Menu.
3. **Command palette** — accessible filter name, arrow/Home/End
   highlight, `aria-activedescendant`, focus return to Commands.
4. **Global search** — `combobox` / `listbox` / `option` wiring.
5. **Session chip** — `sessionStatusChipAccessibleName` (expired and
   warning are explicit, not color-only).
6. **Expired session banner** — `role="alert"` (was `status`). Warning
   remains polite `status`. Copy unchanged.
7. **Secret fields** — `aria-describedby` on the mask hint.
8. **Notifications** — Dismiss named with the notification title.
9. **Action wizard** — Esc closes the dialog.
10. **Workflow home view toggle** — `aria-pressed` on List / Cards.

UX.10 canvas-first chrome (Relates to #205 / Part of #195. **Keep #205 open.**)
No screen-reader graph rewrite.

11. **Editor top bar** — accessible names for Add action, Library, YAML,
    Inspector, Save draft, Publish, Runs, Start published, Publish note.
12. **Drawers** — Esc closes library / YAML / runs, and inspector on the
    `max-width: 767px` inspector-first breakpoint, then restores focus
    to the matching top-bar control. Command palette already did this.
13. **Selection announcement** — polite live region so a selected node
    is enough to use the inspector (name, type, with/pins/credentials).
14. **No nested `<main>`** — skip target stays `#main-content` (shell
    `div`); the editor route keeps a single page `<main>`.
15. **Status never color-only** — canvas node state stays icon + text;
    dirty/saved and workflow status stay words.

R7.4 rewrite satellites (Relates to #279 / Part of #233.
**Keep #279 open.**) Inherit `R7_HARD_LINE`. No SR graph rewrite.
Touch stays `touch-inspector-first`.

16. **Palette / Add action wizard** — Esc closes and restores focus
    to the opening control (`Add action` or the library/canvas +).
17. **NDV add-credential wizard** — Esc closes the masked modal and
    returns focus to **Add credential** on the inspector rail.
18. **Runs overlay** — same drawer Esc + focus return as UX.10;
    status stays `ExecutionStatusBadge` icon + text.
19. **Activation chrome** (editor + home column) — live/not-live is
    icon + text, never color alone. **Activation** is labeled.
20. **Start published + home drawers** — Esc closes Start / Webhooks
    / Schedules and restores focus to the matching control. No nested
    `<main>` on those satellites.

Contract tests: `apps/web/src/lib/e12-accessibility-contract.test.ts`
and `apps/web/src/lib/rewrite-satellite-a11y.test.ts`
(picked up by `pnpm --filter @flowforge/web test`).

## Already in good shape

- `html lang="en"`.
- Route pages use `<main>` and a single `<h1>`.
- Status is never color-only on executions, alerts, and canvas nodes
  (icon + text + `sr-only` description).
- Dialogs that existed before this story (`role="dialog"` +
  `aria-labelledby`: action wizard, credential test/delete, run
  confirm, command palette).
- Validation and stripped-secret banners use live/status regions.
- Permission matrix uses `sr-only` cell text (not color ticks alone).
- Execution detail already has skip-to-error / skip-to-indeterminate
  links.

## Tracked gaps (not blocking this story)

Do not invent a full canvas SR redesign here.

| Gap | Why tracked | Suggested follow-up |
| --- | --- | --- |
| Action wizard / palette / search have no focus **trap** | Esc + initial focus cover the primary path; Tab can leave the overlay | Focus trap helper shared by dialogs |
| Canvas `role="application"` is a custom widget | Keyboard pan/select/zoom exist; a full screen-reader graph is not implemented | UX.10 announces the selected node for the inspector. Do not invent an SR graph rewrite. |
| `text-zinc-500` at 11px is near AA | Body copy uses `zinc-600`/`zinc-800`; helper text is smaller | Bump helper text to `zinc-600` if a contrast audit fails |
| No axe/lighthouse CI gate | Unit/contract tests encode the cheap contracts | Optional playwright + axe on `/workflows` + `/credentials` |
| Touch “inspector-first” editing | UX.10 documents a `max-width: 767px` inspector-first **breakpoint** (not a mobile app). Full touch graph editing is still a gap | Separate UX story — not a mobile app |
| Settings still *links* to membership/isolation | Nav hides them (ADV-024); ungranted roles get API 403 | Acceptable; do not hide Settings |

## How to re-check

```bash
pnpm --filter @flowforge/web test
pnpm --filter @flowforge/web lint
```

Manual (secret-free): Tab from load → skip link → nav → search →
Commands (Ctrl+Shift+K) → Esc back to Commands. Open `/workflows`,
toggle List/Cards, open a draft, Esc the wizard. Confirm vault
secret fields announce the mask hint. On `/executions`, Tab to the
listbox and use arrows. Expired session / approval still use existing
copy (see E12.1 [chloe-ui.md](e12-security-evidence/chloe-ui.md)).

## Ownership

- **Chloe:** this review, operator/admin UI guide, `apps/web` a11y
  fixes above.
- **Jonny:** API/OpenAPI accuracy, deploy/ops/incident/backup docs,
  threat-model review. Keep #184 open until both halves land.
