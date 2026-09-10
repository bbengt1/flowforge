# E12.1 Chloe UI/embed evidence

Relates to #182 / Part of #181. **Keep #182 open.**

This is the Chloe Hit-list proof for
[e12-security-verification.md](../e12-security-verification.md) § Chloe map.
Jonny's harness/CI stays the API/engine authority (#185). These rows only
cover browser surfaces that can disagree with the API (iframe exchange,
session chrome, approval decide).

## How CI encodes the proof

Web contract tests (picked up by `pnpm --filter @flowforge/web test` and
`scripts/e12-security-suite.json`):

| Hit | Route / component | Tests |
| --- | --- | --- |
| Embed exchange + replay | `/embed/v1` · `EmbedExchangeGate` | `apps/web/src/lib/e12-chloe-ui-contract.test.ts` (iframe src, postMessage/form body-only, same-assertion replay `409`, GET `/session` chrome) plus existing `embed-client.test.ts` / ADV-013 checklist |
| Session chrome | `EmbedChrome`, `SessionStatusChip`, `SessionExpiryBanner` | Same Chloe contract (401 → existing stale chrome; expired chip/banner) plus `session.test.ts` / `session-client.test.ts` / `session-embed-contract.test.ts` |
| Expired approval | `/approvals` · `ApprovalValidityBanner`, `ApprovalDecideControls` | Chloe contract + `approval.test.ts` (`approvalValidityBannerState` / `approvalDecideControlsState`) |

Machine pointer: [chloe-ui-last-run.json](chloe-ui-last-run.json).

No new operator chrome. SSRF, fencing, provider failure, and provenance
stay harness/CI-only. Optional credential / script / artifact / isolation /
webhook rows were skipped.

## Screenshots (committed fixtures)

Static SVGs render the **existing** product copy (ProblemBanner `409`,
SessionExpiryBanner stale/expired, ApprovalValidityBanner + disabled decide).
They are display evidence, not a second UI.

- [embed-replay-409.svg](embed-replay-409.svg) — iframe `/embed/v1` after
  replaying the same compact JWS. ProblemBanner heading is `Conflict (409)`.
- [session-stale-401.svg](session-stale-401.svg) — GET `/session` `401`
  latches existing stale chrome (`Session stale` + `Stale session`).
- [approval-expired.svg](approval-expired.svg) — expired approval on
  `/approvals`: banner + Approve/Reject disabled.

## What the iframe path asserts

1. Host frames `{embedOrigin}/embed/v1/…` with display query only.
   `assertion=` is stripped; `assertionFromURL` is always `null`.
2. Allowlisted `flowforge.embed.assertion` postMessage **or** the form
   textarea supplies the compact JWS. Exchange is
   `POST /embed/exchange {assertion, sdk}` with `credentials: include`.
3. First exchange succeeds; chrome waits for `GET /session` `session.embed`
   (ADV-021). Host `?tenant=` / `?workbench=` is not chrome.
4. Replaying the same assertion returns `409` / `replay`. EmbedExchangeGate
   shows existing ProblemBanner (`Conflict (409)` + single-use copy) and
   forgets the JWS.

## Re-run

```bash
pnpm --filter @flowforge/web test
# or only the Chloe checklist:
node --experimental-strip-types --test src/lib/e12-chloe-ui-contract.test.ts
# from apps/web
```
