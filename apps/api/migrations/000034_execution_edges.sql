-- Record the published graph on each run so a step cannot be claimed
-- until its incoming edges have resolved. New workspace-owned table
-- uses the same FORCE RLS helper as the other execution tables.

ALTER TABLE execution_steps DROP CONSTRAINT IF EXISTS execution_steps_status_check;
ALTER TABLE execution_steps ADD CONSTRAINT execution_steps_status_check CHECK (status IN (
    'pending', 'queued', 'running', 'waiting', 'succeeded', 'failed', 'canceled', 'indeterminate', 'skipped'
));

ALTER TABLE execution_steps
    ADD COLUMN IF NOT EXISTS unresolved_incoming integer NOT NULL DEFAULT 0;

ALTER TABLE execution_steps DROP CONSTRAINT IF EXISTS execution_steps_unresolved_nonneg;
ALTER TABLE execution_steps ADD CONSTRAINT execution_steps_unresolved_nonneg
    CHECK (unresolved_incoming >= 0);

ALTER TABLE execution_jobs DROP CONSTRAINT IF EXISTS execution_jobs_status_check;
ALTER TABLE execution_jobs ADD CONSTRAINT execution_jobs_status_check CHECK (status IN (
    'blocked', 'queued', 'claimed', 'running', 'waiting', 'succeeded', 'failed', 'canceled', 'indeterminate', 'skipped'
));

CREATE TABLE execution_edges (
    workspace_id  uuid NOT NULL,
    id            uuid NOT NULL DEFAULT gen_random_uuid(),
    execution_id  uuid NOT NULL,
    from_node     text NOT NULL,
    from_port     text NOT NULL,
    to_node       text NOT NULL,
    to_port       text NOT NULL,
    required      boolean NOT NULL DEFAULT false,
    resolved      boolean NOT NULL DEFAULT false,
    satisfied     boolean NOT NULL DEFAULT false,
    created_at    timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (workspace_id, id),
    CONSTRAINT execution_edges_execution_fk
        FOREIGN KEY (workspace_id, execution_id)
        REFERENCES executions (workspace_id, id)
        ON DELETE CASCADE,
    CONSTRAINT execution_edges_path_unique
        UNIQUE (workspace_id, execution_id, from_node, from_port, to_node, to_port),
    CONSTRAINT execution_edges_from_len CHECK (char_length(from_node) BETWEEN 1 AND 128),
    CONSTRAINT execution_edges_from_port_len CHECK (char_length(from_port) BETWEEN 1 AND 128),
    CONSTRAINT execution_edges_to_len CHECK (char_length(to_node) BETWEEN 1 AND 128),
    CONSTRAINT execution_edges_to_port_len CHECK (char_length(to_port) BETWEEN 1 AND 128)
);

CREATE INDEX execution_edges_to_idx
    ON execution_edges (workspace_id, execution_id, to_node);
CREATE INDEX execution_edges_from_idx
    ON execution_edges (workspace_id, execution_id, from_node);

SELECT app.enable_workspace_isolation('execution_edges');

GRANT SELECT, INSERT, UPDATE, DELETE ON execution_edges TO flowforge_app;

-- Backfill unfinished runs that were planned before edges existed.
-- SECURITY DEFINER + superuser owner bypasses FORCE RLS. The function
-- is not granted to flowforge_app, so a workspace session cannot run
-- a global backfill.
CREATE OR REPLACE FUNCTION app.backfill_execution_dependencies()
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
SET row_security = off
AS $$
DECLARE
    run record;
    ed record;
    edge record;
    b_status text;
    b_output jsonb;
    b_port text;
    b_has_port boolean;
    b_satisfied boolean;
BEGIN
    FOR run IN
        SELECT e.workspace_id, e.id AS execution_id, v.parsed_definition
        FROM executions e
        JOIN workflow_versions v
          ON v.workspace_id = e.workspace_id
         AND v.id = e.workflow_version_id
        WHERE e.status IN ('queued', 'pinned', 'running', 'waiting')
    LOOP
        FOR ed IN
            SELECT
                split_part(item->>'from', '.', 1) AS from_node,
                substr(item->>'from', length(split_part(item->>'from', '.', 1)) + 2) AS from_port,
                split_part(item->>'to', '.', 1) AS to_node,
                substr(item->>'to', length(split_part(item->>'to', '.', 1)) + 2) AS to_port
            FROM jsonb_array_elements(COALESCE(run.parsed_definition->'edges', '[]'::jsonb)) item
        LOOP
            IF ed.from_node IS NULL OR ed.from_node = ''
               OR ed.from_port IS NULL OR ed.from_port = ''
               OR ed.to_node IS NULL OR ed.to_node = ''
               OR ed.to_port IS NULL OR ed.to_port = '' THEN
                CONTINUE;
            END IF;
            INSERT INTO execution_edges (
                workspace_id, execution_id, from_node, from_port, to_node, to_port, required
            )
            SELECT run.workspace_id, run.execution_id, ed.from_node, ed.from_port, ed.to_node, ed.to_port,
                   EXISTS (
                       SELECT 1 FROM execution_steps s
                       WHERE s.workspace_id = run.workspace_id
                         AND s.execution_id = run.execution_id
                         AND s.node_id = ed.from_node
                         AND s.node_type = 'flow.approval'
                   )
            ON CONFLICT ON CONSTRAINT execution_edges_path_unique DO NOTHING;
        END LOOP;

        FOR edge IN
            SELECT id, from_node, from_port
            FROM execution_edges
            WHERE workspace_id = run.workspace_id
              AND execution_id = run.execution_id
              AND resolved = false
        LOOP
            SELECT s.status, s.output_redacted
              INTO b_status, b_output
              FROM execution_steps s
             WHERE s.workspace_id = run.workspace_id
               AND s.execution_id = run.execution_id
               AND s.node_id = edge.from_node
             ORDER BY s.attempt DESC
             LIMIT 1;
            IF NOT FOUND THEN
                CONTINUE;
            END IF;
            IF b_status = 'succeeded' THEN
                b_port := b_output->>'port';
                b_has_port := b_port IS NOT NULL AND b_port <> '';
                IF b_has_port THEN
                    b_satisfied := b_port = edge.from_port;
                ELSE
                    b_satisfied := jsonb_exists(b_output, edge.from_port)
                        AND b_output->edge.from_port IS NOT NULL
                        AND jsonb_typeof(b_output->edge.from_port) IS DISTINCT FROM 'null';
                END IF;
                UPDATE execution_edges
                   SET resolved = true, satisfied = b_satisfied
                 WHERE workspace_id = run.workspace_id
                   AND id = edge.id
                   AND resolved = false;
            ELSIF b_status IN ('failed', 'canceled', 'indeterminate', 'skipped') THEN
                UPDATE execution_edges
                   SET resolved = true, satisfied = false
                 WHERE workspace_id = run.workspace_id
                   AND id = edge.id
                   AND resolved = false;
            END IF;
        END LOOP;

        UPDATE execution_steps s
           SET unresolved_incoming = COALESCE((
               SELECT count(*)::integer
                 FROM execution_edges edg
                WHERE edg.workspace_id = s.workspace_id
                  AND edg.execution_id = s.execution_id
                  AND edg.to_node = s.node_id
                  AND edg.resolved = false
           ), 0)
         WHERE s.workspace_id = run.workspace_id
           AND s.execution_id = run.execution_id
           AND s.attempt = (
               SELECT max(s2.attempt)
                 FROM execution_steps s2
                WHERE s2.workspace_id = s.workspace_id
                  AND s2.execution_id = s.execution_id
                  AND s2.node_id = s.node_id
           );

        UPDATE execution_jobs j
           SET status = 'blocked', updated_at = now()
          FROM execution_steps s
         WHERE s.workspace_id = j.workspace_id
           AND s.id = j.execution_step_id
           AND j.workspace_id = run.workspace_id
           AND j.execution_id = run.execution_id
           AND j.status = 'queued'
           AND j.worker_id IS NULL
           AND s.unresolved_incoming > 0;

        UPDATE execution_steps s
           SET status = 'pending', updated_at = now()
         WHERE s.workspace_id = run.workspace_id
           AND s.execution_id = run.execution_id
           AND s.status = 'queued'
           AND s.unresolved_incoming > 0
           AND EXISTS (
               SELECT 1 FROM execution_jobs j
                WHERE j.workspace_id = s.workspace_id
                  AND j.execution_step_id = s.id
                  AND j.status = 'blocked'
           );
    END LOOP;
END;
$$;

REVOKE ALL ON FUNCTION app.backfill_execution_dependencies() FROM PUBLIC;

SELECT app.backfill_execution_dependencies();
