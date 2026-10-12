-- #660: every skipped step carries why it was skipped.
--
-- skip_reason is NOT NULL exactly when status = 'skipped'. The closed set:
--   branch_not_taken        an incoming edge resolved unsatisfied (untaken
--                           branch, or a join that received nothing)
--   upstream_failed         the run ended failed before the step ran
--   upstream_indeterminate  the run ended indeterminate before the step ran
--   run_cancelled           the run was cancelled before the step ran
--   workflow_deleted        the workflow was deleted before the step ran
--
-- Backfill: on main before this migration, Go wrote 'skipped' only through
-- edge resolution (branch_not_taken). The one-time SQL backfill in 000035
-- (app.backfill_execution_edge_resolution) also skipped steps whose
-- upstream was failed / canceled / indeterminate, so those rows get the
-- matching upstream reason here. Any skipped row whose cause cannot be
-- traced is branch_not_taken. Old 'canceled' never-run steps are left
-- unchanged (legacy value). Forward-only, no down script.

ALTER TABLE execution_steps
    ADD COLUMN skip_reason text;

CREATE OR REPLACE FUNCTION app.backfill_step_skip_reason()
RETURNS void
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
DECLARE
    ws record;
    n integer;
BEGIN
    FOR ws IN SELECT id FROM workspaces LOOP
        PERFORM app.set_workspace_id(ws.id);

        -- Direct cause: a required-or-any incoming edge from a node whose
        -- latest attempt ended failed / indeterminate / canceled.
        UPDATE execution_steps s
           SET skip_reason = CASE
                   WHEN 'failed' = ANY(up.statuses) THEN 'upstream_failed'
                   WHEN 'indeterminate' = ANY(up.statuses) THEN 'upstream_indeterminate'
                   ELSE 'run_cancelled'
               END
          FROM (
                SELECT t.id, array_agg(DISTINCT u.status) AS statuses
                  FROM execution_steps t
                  JOIN execution_edges e
                    ON e.workspace_id = t.workspace_id
                   AND e.execution_id = t.execution_id
                   AND e.to_node = t.node_id
                  JOIN LATERAL (
                        SELECT x.status FROM execution_steps x
                         WHERE x.workspace_id = t.workspace_id
                           AND x.execution_id = t.execution_id
                           AND x.node_id = e.from_node
                         ORDER BY x.attempt DESC LIMIT 1
                  ) u ON true
                 WHERE t.workspace_id = app.current_workspace_id()
                   AND t.status = 'skipped'
                   AND t.skip_reason IS NULL
                   AND u.status IN ('failed', 'indeterminate', 'canceled')
                 GROUP BY t.id
          ) up
         WHERE s.id = up.id;

        -- Cascade: a step skipped because its upstream was itself skipped
        -- for an upstream reason inherits that reason.
        LOOP
            UPDATE execution_steps s
               SET skip_reason = src.reason
              FROM (
                    SELECT DISTINCT ON (t.id) t.id, u.skip_reason AS reason
                      FROM execution_steps t
                      JOIN execution_edges e
                        ON e.workspace_id = t.workspace_id
                       AND e.execution_id = t.execution_id
                       AND e.to_node = t.node_id
                      JOIN LATERAL (
                            SELECT x.status, x.skip_reason FROM execution_steps x
                             WHERE x.workspace_id = t.workspace_id
                               AND x.execution_id = t.execution_id
                               AND x.node_id = e.from_node
                             ORDER BY x.attempt DESC LIMIT 1
                      ) u ON true
                     WHERE t.workspace_id = app.current_workspace_id()
                       AND t.status = 'skipped'
                       AND t.skip_reason IS NULL
                       AND u.status = 'skipped'
                       AND u.skip_reason IN ('upstream_failed', 'upstream_indeterminate', 'run_cancelled')
                     ORDER BY t.id,
                              CASE u.skip_reason WHEN 'upstream_failed' THEN 0
                                                 WHEN 'upstream_indeterminate' THEN 1
                                                 ELSE 2 END
              ) src
             WHERE s.id = src.id;
            GET DIAGNOSTICS n = ROW_COUNT;
            EXIT WHEN n = 0;
        END LOOP;

        UPDATE execution_steps
           SET skip_reason = 'branch_not_taken'
         WHERE workspace_id = app.current_workspace_id()
           AND status = 'skipped'
           AND skip_reason IS NULL;
    END LOOP;
    PERFORM app.set_workspace_id(NULL);
END
$$;

SELECT app.backfill_step_skip_reason();
DROP FUNCTION app.backfill_step_skip_reason();

ALTER TABLE execution_steps
    ADD CONSTRAINT execution_steps_skip_reason_valid
        CHECK (skip_reason IS NULL OR skip_reason IN (
            'branch_not_taken', 'upstream_failed', 'upstream_indeterminate',
            'run_cancelled', 'workflow_deleted')),
    ADD CONSTRAINT execution_steps_skip_reason_iff_skipped
        CHECK ((status = 'skipped') = (skip_reason IS NOT NULL));

-- Re-declare the edge-resolution backfill from 000035 so a re-run keeps
-- the skip_reason CHECK: every row it skips has all incoming edges
-- resolved and none satisfied, so the reason is branch_not_taken. The
-- body is otherwise unchanged.
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
                       unresolved_incoming = 0,
                       skip_reason = 'branch_not_taken'
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
