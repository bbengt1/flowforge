# E12.2 last-run evidence

Relates to #183 / Part of #181. **Keep #183 open.**

- [last-run.json](last-run.json) — suite domain summary from
  `bash scripts/e12-resilience-suite.sh`
- [capacity-last-run.json](capacity-last-run.json) — measured peaks and
  ≥2× headroom ratios
- [restore-schema-last-run.json](restore-schema-last-run.json) — isolated
  encrypted dump/restore pointer
- Control map: [e12-resilience-capacity.md](../e12-resilience-capacity.md)

CI uploads the same files as artifact `e12-resilience-suite`.

The full encrypted compose + API-boot rehearsal remains
`scripts/backup/restore-rehearsal.sh` in `supply-chain.yml`.
