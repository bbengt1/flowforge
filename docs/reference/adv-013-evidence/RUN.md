# ADV-013 last run (2026-09-10T00:18:24Z)

Reproducible two-origin proof for Portal adapter + embed. Portal origin ≠ embed origin.

## Origins

| Role | Origin |
|---|---|
| Portal | `https://portal.test:8443` |
| Embed | `https://embed.test:8444` |
| Hostile | `https://evil.test:8445` |

Hosts file: `127.0.0.1 portal.test embed.test evil.test`

## Positive path (HTTP, this run)

- Distinct HTTPS origins: **true**
- CSP `frame-ancestors` on `/embed/v1` includes Portal, not `evil.test`: **true**
- Standalone `/embed/v1` is `frame-ancestors 'none'`: **true**
- Catalog publishes Portal origin as `frameAncestors`: **true**
- Assertion in URL rejected (`x-flowforge-embed-rejected: 1`): **true**
- Mint via adapter (`POST https://portal.test:8443/portal/assertions`): **true**
  - `tokenId`: `066d588f-4286-4a92-aee3-241cb69792d6`
  - `iss`: `https://portal.cp-ops.example`
  - `sub`: `portal-user-1`
  - `aud`: `flowforge`
- Body-only `POST /embed/exchange` Set-Cookie is `SameSite=None; Partitioned; Secure` (CHIPS): **true**
- Session with CHIPS cookies (`credentials: include` equivalent): **true**
- Empty allowlist fail-closed (real `isEmptyAllowlistFailClosed` module): **true**

## Negatives

- Unallowlisted ancestor `https://evil.test:8445` is **not** in catalog or `/embed/v1` CSP.
- URL assertion path is rejected by middleware (header above).
- Empty `WEB_EMBED_FRAME_ANCESTORS` + `WEB_PORTAL_FRAME_ANCESTORS` + `PORTAL_FRAME_ANCESTORS` fail-closed.

## Screenshots

Captured with isolated Chrome (`--user-data-dir` unique per shot; default profile was locked on this host).

- [portal-host.png](./portal-host.png) — Portal host page at `https://portal.test:8443/` (catalog + shared allowlist).
- [portal-host-mounted.png](./portal-host-mounted.png) — After mint + iframe of `/embed/v1`.
- [hostile-ancestor.png](./hostile-ancestor.png) — `https://evil.test:8445/hostile.html` frames embed; CSP blocks (broken-image iframe).

## Re-run

```bash
# /etc/hosts: 127.0.0.1 portal.test embed.test evil.test
POSTGRES_PASSWORD=adv013local \
  DATABASE_URL='postgres://flowforge:adv013local@127.0.0.1:5432/flowforge?sslmode=disable' \
  bash scripts/adv013-cross-origin.sh
```

See [portal-adapter.md](../portal-adapter.md#adv-013-cross-origin-harness).
