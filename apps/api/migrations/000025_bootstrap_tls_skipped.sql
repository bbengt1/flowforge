-- B.7: optional wizard skip TLS. Status-only mode; no PEM stored.
-- Skip is not a permanent lockout — Settings can enable create/upload later.

ALTER TABLE instance_bootstrap
    DROP CONSTRAINT instance_bootstrap_tls_mode;

ALTER TABLE instance_bootstrap
    ADD CONSTRAINT instance_bootstrap_tls_mode CHECK (tls_mode IN (
        'none', 'self_signed', 'uploaded', 'local_http', 'skipped'
    ));
