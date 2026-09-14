# TLS / proxy foundation

Production: terminate TLS at Ingress (`deploy/k8s/ingress.yaml`). The API ConfigMap sets `REQUIRE_TLS=true` and `TRUSTED_PROXY_CIDRS` so `X-Forwarded-Proto: https` is accepted only from cluster ranges.

Local rehearsal: run Caddy with `Caddyfile` in this directory, then set:

```text
TRUSTED_PROXY_CIDRS=127.0.0.1/32,::1/128
REQUIRE_TLS=true
```

Optional direct TLS on the process (no proxy): `TLS_CERT_FILE` and `TLS_KEY_FILE` together. Both must be set or neither.

First-run wizard B.5 (`POST /api/v1/bootstrap/tls`) writes a created self-signed pair or an uploaded PEM pair to those same paths (atomic replace, key `0600`). PostgreSQL `instance_bootstrap` stores only `tls_ready` / `tls_mode`. Settings later reads `GET /api/v1/bootstrap` `steps.tls.mode` — never the key. Empty paths fail closed (`503`). A process restart is required for `ListenAndServeTLS` to pick up newly written files. Ingress-terminated installs still set the paths so materials have a durable, operator-controlled destination.
