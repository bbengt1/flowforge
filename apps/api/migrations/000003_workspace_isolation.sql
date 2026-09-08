-- E2.2: FORCE RLS, app role (no BYPASSRLS), and composite workspace FKs.
-- Identity tables (tenants/users/roles/bindings) stay unscoped so membership
-- can be checked before app.workspace_id is set. Workspace-owned resource
-- tables use the isolation helper; later domain tables must call it too.

CREATE OR REPLACE FUNCTION app.set_workspace_id(p_workspace_id uuid)
RETURNS void
LANGUAGE plpgsql
AS $$
BEGIN
    -- is_local=true: persists only for the current transaction. An unset
    -- or empty setting matches no RLS rows. Autocommit calls do not leak.
    IF p_workspace_id IS NULL THEN
        PERFORM set_config('app.workspace_id', '', true);
        RETURN;
    END IF;
    PERFORM set_config('app.workspace_id', p_workspace_id::text, true);
END;
$$;

CREATE OR REPLACE FUNCTION app.enable_workspace_isolation(p_table regclass)
RETURNS void
LANGUAGE plpgsql
AS $$
BEGIN
    EXECUTE format('ALTER TABLE %s ENABLE ROW LEVEL SECURITY', p_table);
    EXECUTE format('ALTER TABLE %s FORCE ROW LEVEL SECURITY', p_table);
    EXECUTE format('DROP POLICY IF EXISTS workspace_isolation ON %s', p_table);
    EXECUTE format(
        'CREATE POLICY workspace_isolation ON %s
            FOR ALL
            USING (workspace_id = app.current_workspace_id())
            WITH CHECK (workspace_id = app.current_workspace_id())',
        p_table
    );
END;
$$;

DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'flowforge_app') THEN
        CREATE ROLE flowforge_app NOLOGIN NOSUPERUSER NOBYPASSRLS NOINHERIT;
    ELSE
        ALTER ROLE flowforge_app NOLOGIN NOSUPERUSER NOBYPASSRLS NOINHERIT;
    END IF;
    GRANT flowforge_app TO CURRENT_USER;
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'flowforge')
       AND CURRENT_USER <> 'flowforge' THEN
        GRANT flowforge_app TO flowforge;
    END IF;
END
$$;

GRANT USAGE ON SCHEMA public TO flowforge_app;
GRANT USAGE ON SCHEMA app TO flowforge_app;
GRANT EXECUTE ON FUNCTION app.current_workspace_id() TO flowforge_app;
GRANT EXECUTE ON FUNCTION app.set_workspace_id(uuid) TO flowforge_app;
GRANT EXECUTE ON FUNCTION app.enable_workspace_isolation(regclass) TO flowforge_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO flowforge_app;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO flowforge_app;
ALTER DEFAULT PRIVILEGES IN SCHEMA public
    GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO flowforge_app;
ALTER DEFAULT PRIVILEGES IN SCHEMA public
    GRANT USAGE, SELECT ON SEQUENCES TO flowforge_app;

-- Isolation hook tables for workspace-owned resources that exist today
-- (credentials, artifacts, jobs, caches, realtime channels, audits).
-- Later epics replace/extend these; they must keep FORCE RLS + composite FKs.
CREATE TABLE workspace_records (
    workspace_id  uuid NOT NULL REFERENCES workspaces (id) ON DELETE CASCADE,
    id            uuid NOT NULL DEFAULT gen_random_uuid(),
    kind          text NOT NULL,
    name          text NOT NULL,
    metadata      jsonb NOT NULL DEFAULT '{}'::jsonb,
    created_by    uuid REFERENCES users (id),
    created_at    timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (workspace_id, id),
    CONSTRAINT workspace_records_kind_check CHECK (kind IN (
        'credential', 'artifact', 'job', 'cache', 'realtime', 'audit'
    )),
    CONSTRAINT workspace_records_name_len CHECK (char_length(name) BETWEEN 1 AND 200)
);

CREATE INDEX workspace_records_workspace_kind_idx
    ON workspace_records (workspace_id, kind, created_at DESC);
CREATE INDEX workspace_records_id_idx ON workspace_records (id);

CREATE TABLE workspace_record_links (
    workspace_id  uuid NOT NULL,
    id            uuid NOT NULL DEFAULT gen_random_uuid(),
    parent_id     uuid NOT NULL,
    kind          text NOT NULL,
    created_at    timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (workspace_id, id),
    CONSTRAINT workspace_record_links_parent_fk
        FOREIGN KEY (workspace_id, parent_id)
        REFERENCES workspace_records (workspace_id, id)
        ON DELETE CASCADE,
    CONSTRAINT workspace_record_links_kind_check CHECK (kind IN (
        'credential', 'artifact', 'job', 'cache', 'realtime', 'audit'
    ))
);

CREATE INDEX workspace_record_links_parent_idx
    ON workspace_record_links (workspace_id, parent_id);

SELECT app.enable_workspace_isolation('workspace_records');
SELECT app.enable_workspace_isolation('workspace_record_links');

GRANT SELECT, INSERT, UPDATE, DELETE ON workspace_records TO flowforge_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON workspace_record_links TO flowforge_app;
