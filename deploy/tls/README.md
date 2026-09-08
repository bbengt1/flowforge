# TLS / proxy foundation

Production: terminate TLS at Ingress (`deploy/k8s/ingress.yaml`). The API ConfigMap sets `REQUIRE_TLS=true` and `TRUSTED_PROXY_CIDRS` so `X-Forwarded-Proto: https` is accepted only from cluster ranges.

Local rehearsal: run Caddy with `Caddyfile` in this directory, then set:

```text
TRUSTED_PROXY_CIDRS=127.0.0.1/32,::1/128
REQUIRE_TLS=true
```

Optional direct TLS on the process (no proxy): `TLS_CERT_FILE` and `TLS_KEY_FILE` together. Both must be set or neither.
