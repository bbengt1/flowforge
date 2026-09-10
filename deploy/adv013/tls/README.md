# ADV-013 local TLS material

`scripts/adv013-cross-origin.sh` writes a local CA + SAN cert covering
`portal.test`, `embed.test`, `evil.test`, and `localhost` here.

Do not commit private keys. `*.pem` is gitignored at the repo root.
These certs are for the documented local HTTPS rehearsal only.
