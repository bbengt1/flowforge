-- Retry gates and stale approval close.
--
-- Role requirement:
-- 000034_execution_edges.sql defines app.backfill_execution_dependencies()
-- as SECURITY DEFINER with SET row_security = off. Creating and running
-- that function requires the migration role to be a superuser or to have
-- BYPASSRLS. It is not granted to flowforge_app.
--
-- This migration does not set row_security = off and does not use
-- BYPASSRLS. app.backfill_execution_edge_resolution() and
-- app.backfill_close_stale_approvals() walk public.workspaces and call
-- app.set_workspace_id so FORCE RLS still applies. A superuser bypasses
-- RLS even after that setting, so each statement also filters on
-- app.current_workspace_id(). The functions are not granted to
-- flowforge_app. The migration role must be able to read workspaces
-- and call app.set_workspace_id. A NOBYPASSRLS role can run them.
--
-- app.close_pending_approvals is granted to flowforge_app. It only
-- updates rows visible under the current workspace setting.

ALTER TABLE approvals DROP CONSTRAINT IF EXISTS approvals_status_check;
ALTER TABLE approvals ADD CONSTRAINT approvals_status_check CHECK (status IN (
    'pending', 'approved', 'rejected', 'expired', 'invalidated', 'canceled'
));

ALTER TABLE approvals ADD COLUMN IF NOT EXISTS close_reason text;

ALTER TABLE approvals DROP CONSTRAINT IF EXISTS approvals_close_reason_check;
ALTER TABLE approvals ADD CONSTRAINT approvals_close_reason_check CHECK (
    (status = 'canceled' AND close_reason IN ('run_canceled', 'workflow_deleted'))
    OR (status <> 'canceled' AND close_reason IS NULL)
);

ALTER TABLE approval_events DROP CONSTRAINT IF EXISTS approval_events_type_check;
ALTER TABLE approval_events ADD CONSTRAINT approval_events_type_check CHECK (event_type IN (
    'created', 'approved', 'rejected', 'expired', 'invalidated', 'canceled'
));

CREATE OR REPLACE FUNCTION app.close_pending_approvals(p_execution uuid, p_reason text, p_now timestamptz)
RETURNS integer
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
DECLARE
    n integer := 0;
BEGIN
    IF p_reason IS NULL OR p_reason NOT IN ('run_canceled', 'workflow_deleted') THEN
        RAISE EXCEPTION 'invalid approval close reason' USING ERRCODE = '22023';
    END IF;
    WITH closed AS (
        UPDATE approvals
           SET status = 'canceled',
               close_reason = p_reason,
               decided_by = NULL,
               decided_at = NULL,
               updated_at = p_now
         WHERE execution_id = p_execution
           AND status = 'pending'
        RETURNING workspace_id, id
    ),
    logged AS (
        INSERT INTO approval_events (workspace_id, approval_id, event_type, actor_id, details, occurred_at)
        SELECT workspace_id, id, 'canceled', NULL, jsonb_build_object('reason', p_reason), p_now
          FROM closed
        RETURNING 1
    )
    SELECT count(*)::integer INTO n FROM logged;
    RETURN n;
END;
$$;

REVOKE ALL ON FUNCTION app.close_pending_approvals(uuid, text, timestamptz) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.close_pending_approvals(uuid, text, timestamptz) TO flowforge_app;

-- Repair execution edges that 000034 resolved in one pass. Edges from a
-- failed or indeterminate step stay unresolved. Skips repeat until a pass
-- changes nothing, including a step whose upstream gate already finished
-- on the rejected port.
CREATE OR REPLACE FUNCTION app.backfill_execution_edge_resolution()
RETURNS void
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
DECLARE
    ws record;
    run record;
    ed record;
    n integer;
    n_resolve integer;
    n_skip integer;
BEGIN
    FOR ws IN SELECT id FROM workspaces LOOP
        PERFORM app.set_workspace_id(ws.id);

        FOR run IN
            SELECT e.id AS execution_id, v.parsed_definition
              FROM executions e
              JOIN workflow_versions v
                ON v.workspace_id = e.workspace_id
               AND v.id = e.workflow_version_id
             WHERE e.workspace_id = app.current_workspace_id()
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
                SELECT app.current_workspace_id(), run.execution_id, ed.from_node, ed.from_port, ed.to_node, ed.to_port,
                       NOT EXISTS (
                           SELECT 1
                             FROM jsonb_array_elements(COALESCE(run.parsed_definition->'nodes', '[]'::jsonb)) node
                            WHERE node->>'id' = ed.to_node
                              AND node->>'join' = 'any'
                       )
                ON CONFLICT ON CONSTRAINT execution_edges_path_unique DO NOTHING;
            END LOOP;
        END LOOP;

        UPDATE execution_edges e
           SET resolved = false, satisfied = false
          FROM execution_steps s
         WHERE e.workspace_id = app.current_workspace_id()
           AND s.workspace_id = e.workspace_id
           AND s.execution_id = e.execution_id
           AND s.node_id = e.from_node
           AND s.status IN ('failed', 'indeterminate')
           AND e.resolved = true
           AND s.attempt = (
               SELECT max(s2.attempt)
                 FROM execution_steps s2
                WHERE s2.workspace_id = s.workspace_id
                  AND s2.execution_id = s.execution_id
                  AND s2.node_id = s.node_id
           );

        LOOP
            n_resolve := 0;

            UPDATE execution_edges e
               SET resolved = true,
                   satisfied = CASE
                       WHEN COALESCE(s.output_redacted->>'port', '') <> ''
                           THEN s.output_redacted->>'port' = e.from_port
                       ELSE true
                   END
              FROM execution_steps s
             WHERE e.workspace_id = app.current_workspace_id()
               AND s.workspace_id = e.workspace_id
               AND s.execution_id = e.execution_id
               AND s.node_id = e.from_node
               AND s.status = 'succeeded'
               AND e.resolved = false
               AND s.attempt = (
                   SELECT max(s2.attempt)
                     FROM execution_steps s2
                    WHERE s2.workspace_id = s.workspace_id
                      AND s2.execution_id = s.execution_id
                      AND s2.node_id = s.node_id
               );
            GET DIAGNOSTICS n = ROW_COUNT;
            n_resolve := n_resolve + n;

            UPDATE execution_edges e
               SET resolved = true, satisfied = false
              FROM execution_steps s
             WHERE e.workspace_id = app.current_workspace_id()
               AND s.workspace_id = e.workspace_id
               AND s.execution_id = e.execution_id
               AND s.node_id = e.from_node
               AND s.status IN ('skipped', 'canceled')
               AND e.resolved = false
               AND s.attempt = (
                   SELECT max(s2.attempt)
                     FROM execution_steps s2
                    WHERE s2.workspace_id = s.workspace_id
                      AND s2.execution_id = s.execution_id
                      AND s2.node_id = s.node_id
               );
            GET DIAGNOSTICS n = ROW_COUNT;
            n_resolve := n_resolve + n;

            WITH targets AS (
                SELECT s.id
                  FROM execution_steps s
                 WHERE s.workspace_id = app.current_workspace_id()
                   AND s.status IN ('pending', 'queued')
                   AND s.started_at IS NULL
                   AND s.attempt = (
                       SELECT max(s2.attempt)
                         FROM execution_steps s2
                        WHERE s2.workspace_id = s.workspace_id
                          AND s2.execution_id = s.execution_id
                          AND s2.node_id = s.node_id
                   )
                   AND EXISTS (
                       SELECT 1 FROM execution_edges e
                        WHERE e.workspace_id = s.workspace_id
                          AND e.execution_id = s.execution_id
                          AND e.to_node = s.node_id
                   )
                   AND (
                       EXISTS (
                           SELECT 1 FROM execution_edges e
                            WHERE e.workspace_id = s.workspace_id
                              AND e.execution_id = s.execution_id
                              AND e.to_node = s.node_id
                              AND e.resolved
                              AND NOT e.satisfied
                              AND e.required
                       )
                       OR (
                           NOT EXISTS (
                               SELECT 1 FROM execution_edges e
                                WHERE e.workspace_id = s.workspace_id
                                  AND e.execution_id = s.execution_id
                                  AND e.to_node = s.node_id
                                  AND NOT e.resolved
                           )
                           AND NOT EXISTS (
                               SELECT 1 FROM execution_edges e
                                WHERE e.workspace_id = s.workspace_id
                                  AND e.execution_id = s.execution_id
                                  AND e.to_node = s.node_id
                                  AND e.resolved
                                  AND e.satisfied
                           )
                       )
                   )
            ),
            skipped_steps AS (
                UPDATE execution_steps s
                   SET status = 'skipped',
                       finished_at = COALESCE(s.finished_at, now()),
                       updated_at = now(),
                       unresolved_incoming = 0
                  FROM targets t
                 WHERE s.id = t.id
                RETURNING s.id, s.workspace_id
            ),
            skipped_jobs AS (
                UPDATE execution_jobs j
                   SET status = 'skipped', updated_at = now()
                  FROM skipped_steps ss
                 WHERE j.workspace_id = ss.workspace_id
                   AND j.execution_step_id = ss.id
                   AND j.status IN ('blocked', 'queued')
                RETURNING j.id
            )
            SELECT count(*)::integer INTO n_skip FROM skipped_steps;

            EXIT WHEN n_resolve = 0 AND n_skip = 0;
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
         WHERE s.workspace_id = app.current_workspace_id()
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
         WHERE j.workspace_id = app.current_workspace_id()
           AND s.workspace_id = j.workspace_id
           AND s.id = j.execution_step_id
           AND j.status = 'queued'
           AND j.worker_id IS NULL
           AND s.unresolved_incoming > 0
           AND s.status IN ('pending', 'queued');

        UPDATE execution_steps s
           SET status = 'pending', updated_at = now()
         WHERE s.workspace_id = app.current_workspace_id()
           AND s.status = 'queued'
           AND s.unresolved_incoming > 0
           AND EXISTS (
               SELECT 1 FROM execution_jobs j
                WHERE j.workspace_id = s.workspace_id
                  AND j.execution_step_id = s.id
                  AND j.status = 'blocked'
           );
    END LOOP;
    PERFORM app.set_workspace_id(NULL);
END;
$$;

REVOKE ALL ON FUNCTION app.backfill_execution_edge_resolution() FROM PUBLIC;

CREATE OR REPLACE FUNCTION app.backfill_close_stale_approvals()
RETURNS void
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
DECLARE
    ws record;
    run record;
BEGIN
    FOR ws IN SELECT id FROM workspaces LOOP
        PERFORM app.set_workspace_id(ws.id);
        FOR run IN
            SELECT e.id AS execution_id,
                   CASE
                       WHEN e.status = 'canceled' THEN 'run_canceled'
                       ELSE 'workflow_deleted'
                   END AS reason
              FROM executions e
             WHERE e.workspace_id = app.current_workspace_id()
               AND (
                    e.status = 'canceled'
                OR (
                    e.status = 'failed'
                    AND EXISTS (
                        SELECT 1 FROM execution_steps s
                         WHERE s.workspace_id = e.workspace_id
                           AND s.execution_id = e.id
                           AND COALESCE(s.error_redacted->>'code', '') = 'workflow_deleted'
                    )
                )
               )
        LOOP
            PERFORM app.close_pending_approvals(run.execution_id, run.reason, now());
        END LOOP;
    END LOOP;
    PERFORM app.set_workspace_id(NULL);
END;
$$;

REVOKE ALL ON FUNCTION app.backfill_close_stale_approvals() FROM PUBLIC;

SELECT app.backfill_execution_edge_resolution();
SELECT app.backfill_close_stale_approvals();
