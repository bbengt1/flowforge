-- E5.4: audit records are append-only to the application role.
-- Retention deletes go through app.purge_expired_audit_events (SECURITY DEFINER).
-- Operational alerts persist authorization, replay, policy, and redaction
-- failures with correlation/resource identifiers only.

REVOKE UPDATE, DELETE ON audit_events FROM flowforge_app;
REVOKE UPDATE, DELETE ON audit_events_2026_08 FROM flowforge_app;
REVOKE UPDATE, DELETE ON audit_events_2026_09 FROM flowforge_app;
REVOKE UPDATE, DELETE ON audit_events_2026_10 FROM flowforge_app;
REVOKE UPDATE, DELETE ON audit_events_2026_11 FROM flowforge_app;
REVOKE UPDATE, DELETE ON audit_events_2026_12 FROM flowforge_app;
REVOKE UPDATE, DELETE ON audit_events_2027_01 FROM flowforge_app;
REVOKE UPDATE, DELETE ON audit_events_2027_02 FROM flowforge_app;
REVOKE UPDATE, DELETE ON audit_events_2027_03 FROM flowforge_app;
REVOKE UPDATE, DELETE ON audit_events_default FROM flowforge_app;

CREATE OR REPLACE FUNCTION app.ensure_audit_month_partition(p_start date)
RETURNS void
LANGUAGE plpgsql
AS $$
DECLARE
    part_name text;
    p_end date;
BEGIN
    p_start := date_trunc('month', p_start)::date;
    p_end := (p_start + interval '1 month')::date;
    part_name := format('audit_events_%s', to_char(p_start, 'YYYY_MM'));
    IF to_regclass('public.' || part_name) IS NULL THEN
        EXECUTE format(
            'CREATE TABLE %I PARTITION OF audit_events FOR VALUES FROM (%L) TO (%L)',
            part_name, p_start, p_end
        );
        EXECUTE format('GRANT SELECT, INSERT ON TABLE %I TO flowforge_app', part_name);
        EXECUTE format('REVOKE UPDATE, DELETE ON TABLE %I FROM flowforge_app', part_name);
    END IF;
END;
$$;

CREATE OR REPLACE FUNCTION app.purge_expired_audit_events(p_now timestamptz)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    deleted integer := 0;
    ws uuid;
BEGIN
    ws := app.current_workspace_id();
    IF ws IS NULL THEN
        RETURN 0;
    END IF;
    DELETE FROM audit_events
    WHERE workspace_id = ws
      AND retention_until <= p_now;
    GET DIAGNOSTICS deleted = ROW_COUNT;
    RETURN deleted;
END;
$$;

REVOKE ALL ON FUNCTION app.purge_expired_audit_events(timestamptz) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.purge_expired_audit_events(timestamptz) TO flowforge_app;

CREATE TABLE operational_alerts (
    workspace_id     uuid NOT NULL REFERENCES workspaces (id) ON DELETE CASCADE,
    id               uuid NOT NULL DEFAULT gen_random_uuid(),
    kind             text NOT NULL,
    severity         text NOT NULL,
    action           text NOT NULL DEFAULT '',
    resource_type    text NOT NULL DEFAULT '',
    resource_id      uuid,
    correlation_id   text,
    request_id       text,
    actor_id         uuid REFERENCES users (id),
    outcome          text NOT NULL,
    code             text NOT NULL,
    details_redacted jsonb NOT NULL DEFAULT '{}'::jsonb,
    acknowledged_at  timestamptz,
    acknowledged_by  uuid REFERENCES users (id),
    occurred_at      timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (workspace_id, id),
    CONSTRAINT operational_alerts_kind_check CHECK (kind IN (
        'authorization', 'replay', 'policy', 'redaction'
    )),
    CONSTRAINT operational_alerts_severity_check CHECK (severity IN ('warning', 'critical')),
    CONSTRAINT operational_alerts_action_len CHECK (char_length(action) <= 128),
    CONSTRAINT operational_alerts_resource_type_len CHECK (char_length(resource_type) <= 64),
    CONSTRAINT operational_alerts_outcome_len CHECK (char_length(outcome) BETWEEN 1 AND 64),
    CONSTRAINT operational_alerts_code_len CHECK (char_length(code) BETWEEN 1 AND 64),
    CONSTRAINT operational_alerts_correlation_len CHECK (correlation_id IS NULL OR char_length(correlation_id) BETWEEN 1 AND 128),
    CONSTRAINT operational_alerts_request_len CHECK (request_id IS NULL OR char_length(request_id) BETWEEN 1 AND 128),
    CONSTRAINT operational_alerts_details_obj CHECK (jsonb_typeof(details_redacted) = 'object')
);

CREATE INDEX operational_alerts_workspace_occurred_idx
    ON operational_alerts (workspace_id, occurred_at DESC);
CREATE INDEX operational_alerts_open_idx
    ON operational_alerts (workspace_id, kind, occurred_at DESC)
    WHERE acknowledged_at IS NULL;
CREATE INDEX operational_alerts_id_idx ON operational_alerts (id);
CREATE INDEX operational_alerts_resource_idx
    ON operational_alerts (workspace_id, resource_type, resource_id, occurred_at DESC);

SELECT app.enable_workspace_isolation('operational_alerts');

GRANT SELECT, INSERT, UPDATE ON operational_alerts TO flowforge_app;

INSERT INTO permissions (key) VALUES
    ('alert.view'),
    ('alert.ack')
ON CONFLICT (key) DO NOTHING;

INSERT INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id
FROM roles r
JOIN permissions p ON (r.key, p.key) IN (
    ('viewer', 'alert.view'),
    ('editor', 'alert.view'),
    ('publisher', 'alert.view'),
    ('operator', 'alert.view'),
    ('operator', 'alert.ack'),
    ('approver', 'alert.view'),
    ('admin', 'alert.view'),
    ('admin', 'alert.ack')
)
ON CONFLICT DO NOTHING;
