# Security Policy

## How to report

Report vulnerabilities **privately**. Do not open a public GitHub issue, discussion, or pull request that includes an exploit, secret, or working reproduction of a security flaw.

The disclosure path for this repository is **GitHub Security Advisories / private vulnerability reporting** on [`bbengt1/flowforge`](https://github.com/bbengt1/flowforge):

**https://github.com/bbengt1/flowforge/security/advisories/new**

There is no `security@` inbox and no other mailing list. Use that form only.

Include:

- Affected surface (`apps/api`, `apps/web`, `deploy/`, worker, or docs/config)
- Impact (authz bypass, secret leak, tenancy/isolation break, RCE, fail-open)
- Steps to reproduce **without** live secrets, customer data, or a public PoC
- Whether a hard line is involved: fail closed, drafts never run, vault display-name + UUID only, ADV-021, ADV-024

## What to expect

- Acknowledgement of a complete report within **5 business days**.
- A private update when the report is confirmed or declined, and when a fix is on `main` or an advisory is published.
- The report stays private until a maintainer publishes an advisory. Credit is optional; say if you want it.

No bounty program. Do not ask for a public issue or a dedicated mailbox.

## Hard lines (do not weaken while fixing)

Fail closed. No secrets in logs, responses, YAML, URLs, or `localStorage`. Drafts never run. Embed chrome from `GET /session` `session.embed` only (ADV-021). Membership / isolation stay grant-gated (ADV-024).
