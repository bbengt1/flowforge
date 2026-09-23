# Internal notes

These pages are planning and gap notes. They are not operator or product documentation, and they are not part of the published `docs/` set.

| File | Role |
| --- | --- |
| [claude-code-gap-analysis.md](claude-code-gap-analysis.md) | Enterprise architecture gap analysis (findings A–I) |
| [master-implementation-plan.md](master-implementation-plan.md) | Issue-creation backlog for the MVP, including GitHub issue links |

Product documentation stays in the parent `docs/` tree: architecture, reference, operations, guides, and deployment. Product pages must not link into this directory.

`scripts/check-public-docs.py` fails when a product Markdown file contains a GitHub issue or pull number, a contributor name (Chloe, jonny, Arie, Gracie, Terry, Brent), or a link into `docs/internal/`. The copyright notice “Brent Bengtson” is allowed. Hex colors, `PKCS#8`, and heading anchors are not issue numbers. CI runs the check in `.github/workflows/docs-public.yml`.
