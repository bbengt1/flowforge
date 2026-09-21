## Summary

<!-- What changed and why. -->

Closes #

## Hard lines

- [ ] Fail closed (missing/malformed config, authz, allowlists, unknown fields)
- [ ] No secrets in logs, responses, YAML, URLs, or `localStorage` (vault: display-name + UUID only)
- [ ] Drafts never run (publish, then start a published version)
- [ ] ADV-021 — embed chrome from `GET /session` `session.embed` only; host query is display-only
- [ ] ADV-024 — membership / isolation stay grant-gated; isolation success is a denial

## Tests

- [ ] API: `go test ./...` in `apps/api` when the control plane changed
- [ ] Web: `pnpm test` (and `pnpm lint --max-warnings=0` / `pnpm build` when UI changed)
