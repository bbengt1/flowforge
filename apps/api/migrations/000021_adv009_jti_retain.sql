-- ADV-009: retain consumed assertion JTIs past JWT exp.
-- Consume is INSERT … ON CONFLICT DO NOTHING RETURNING only.
-- Do not delete solely because expires_at (assertion exp) has elapsed.
-- PurgeExpired deletes WHERE retain_until <= now (exp + 24h).

ALTER TABLE embed_assertion_jtis
    ADD COLUMN retain_until timestamptz;

UPDATE embed_assertion_jtis
    SET retain_until = expires_at + interval '24 hours'
    WHERE retain_until IS NULL;

ALTER TABLE embed_assertion_jtis
    ALTER COLUMN retain_until SET NOT NULL;

CREATE INDEX embed_assertion_jtis_retain_until_idx
    ON embed_assertion_jtis (retain_until);
