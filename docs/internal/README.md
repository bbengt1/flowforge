# Internal notes

This directory is **not** operator or product documentation.

It holds planning briefs, the enterprise-architecture gap analysis, and the
MVP backlog. Published docs are everything else under `docs/`.

Published Markdown must not:

- link to this directory
- contain GitHub issue or pull-request numbers
- contain contributor names (Chloe, jonny, Arie, Gracie, Terry, Brent, Bengtson)

Story ids such as `ADV-021`, `E12.3`, and `G.1.1` stay in product docs.
They name behavior, not a GitHub issue.

Check (also the supply-chain policy job):

```bash
python3 scripts/check-public-docs.py
```
