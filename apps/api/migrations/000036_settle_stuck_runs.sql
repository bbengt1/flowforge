-- Settle runs left active after a finished graph, and close approvals
-- stranded by a delete or a gate that already left waiting.
--
-- Role requirement:
-- This migration does not set row_security = off and does not use
-- BYPASSRLS. app.backfill_settle_stuck_runs() walks public.workspaces
-- and calls app.set_workspace_id so FORCE RLS still applies. A superuser
-- bypasses RLS even after that setting, so each statement also filters
-- on app.current_workspace_id(). The function is not granted to
-- flowforge_app. The migration role must be able to read workspaces and
-- call app.set_workspace_id. A NOBYPASSRLS role can run it.
--
-- Lock and write order matches runtime delete and claim: for each
-- workspace, lock the workflow, then its executions FOR UPDATE in id
-- order, recompute from those locked rows, then write the execution
-- before its jobs, steps, and approvals. The function stays idempotent.
--
-- Do not edit 000035. That migration is already applied. This file repairs
-- the rows it left behind: a rejected gate whose downstream steps were
-- skipped while the execution stayed running, a parked run on a
-- soft-deleted workflow whose approval is still pending, and a pending
-- approval whose gate step is no longer waiting.

CREATE OR REPLACE FUNCTION app.backfill_settle_stuck_runs()
RETURNS void
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
DECLARE
    ws record;
    wf record;
    run record;
    saw_indet boolean;
    saw_failed boolean;
    saw_canceled boolean;
    saw_success boolean;
    saw_skipped boolean;
    n_jobs integer;
    n_open integer;
    n_inflight integer;
    next_status text;
BEGIN
    FOR ws IN SELECT id FROM workspaces ORDER BY id LOOP
        PERFORM app.set_workspace_id(ws.id);

        FOR wf IN
            SELECT w.id
              FROM workflows w
             WHERE w.workspace_id = app.current_workspace_id()
               AND (
                   EXISTS (
                       SELECT 1
                         FROM executions e
                        WHERE e.workspace_id = w.workspace_id
                          AND e.workflow_id = w.id
                          AND e.status IN ('queued', 'running', 'waiting')
                   )
                   OR EXISTS (
                       SELECT 1
                         FROM approvals a
                         JOIN executions e
                           ON e.workspace_id = a.workspace_id
                          AND e.id = a.execution_id
                        WHERE a.workspace_id = w.workspace_id
                          AND e.workflow_id = w.id
                          AND a.status = 'pending'
                   )
               )
             ORDER BY w.id
               FOR UPDATE
        LOOP
            FOR run IN
                SELECT e.id, (w.deleted_at IS NOT NULL) AS is_deleted
                  FROM executions e
                  JOIN workflows w
                    ON w.workspace_id = e.workspace_id
                   AND w.id = e.workflow_id
                 WHERE e.workspace_id = app.current_workspace_id()
                   AND e.workflow_id = wf.id
                   AND (
                       e.status IN ('queued', 'running', 'waiting')
                       OR EXISTS (
                           SELECT 1
                             FROM approvals a
                            WHERE a.workspace_id = e.workspace_id
                              AND a.execution_id = e.id
                              AND a.status = 'pending'
                       )
                   )
                 ORDER BY e.id
                   FOR UPDATE OF e
            LOOP
                SELECT
                    COALESCE(bool_or(j.status = 'indeterminate'), false),
                    COALESCE(bool_or(j.status = 'failed'), false),
                    COALESCE(bool_or(j.status = 'canceled'), false),
                    COALESCE(bool_or(j.status = 'succeeded'), false),
                    COALESCE(bool_or(j.status = 'skipped'), false),
                    count(j.id)::integer,
                    COALESCE(count(*) FILTER (
                        WHERE j.status IN ('queued', 'claimed', 'running', 'waiting', 'blocked')
                    ), 0)::integer,
                    COALESCE(count(*) FILTER (
                        WHERE j.status IN ('queued', 'claimed', 'running')
                    ), 0)::integer
                  INTO saw_indet, saw_failed, saw_canceled, saw_success, saw_skipped, n_jobs, n_open, n_inflight
                  FROM execution_jobs j
                  JOIN execution_steps s
                    ON s.workspace_id = j.workspace_id
                   AND s.id = j.execution_step_id
                 WHERE j.workspace_id = app.current_workspace_id()
                   AND j.execution_id = run.id
                   AND s.attempt = (
                       SELECT max(s2.attempt)
                         FROM execution_steps s2
                        WHERE s2.workspace_id = s.workspace_id
                          AND s2.execution_id = s.execution_id
                          AND s2.node_id = s.node_id
                   );

                -- A soft-deleted workflow with no in-flight job takes the
                -- delete end state. Write the execution, then its children.
                IF run.is_deleted AND n_inflight = 0 AND EXISTS (
                    SELECT 1
                      FROM executions e
                     WHERE e.workspace_id = app.current_workspace_id()
                       AND e.id = run.id
                       AND e.status IN ('queued', 'running', 'waiting')
                ) THEN
                    UPDATE executions
                       SET status = 'failed',
                           finished_at = COALESCE(finished_at, now()),
                           updated_at = now()
                     WHERE workspace_id = app.current_workspace_id()
                       AND id = run.id
                       AND status IN ('queued', 'running', 'waiting');
                    UPDATE execution_jobs
                       SET status = 'canceled',
                           worker_id = NULL,
                           lease_expires_at = NULL,
                           available_at = now(),
                           updated_at = now()
                     WHERE workspace_id = app.current_workspace_id()
                       AND execution_id = run.id
                       AND status IN ('waiting', 'pending', 'blocked');
                    UPDATE execution_steps
                       SET status = 'canceled',
                           error_redacted = '{"code":"workflow_deleted","message":"Workflow was deleted."}'::jsonb,
                           finished_at = COALESCE(finished_at, now()),
                           updated_at = now()
                     WHERE workspace_id = app.current_workspace_id()
                       AND execution_id = run.id
                       AND status IN ('waiting', 'pending', 'blocked');
                    PERFORM app.close_pending_approvals(run.id, 'workflow_deleted', now());
                ELSIF n_jobs > 0 AND n_open = 0 AND EXISTS (
                    SELECT 1
                      FROM executions e
                     WHERE e.workspace_id = app.current_workspace_id()
                       AND e.id = run.id
                       AND e.status IN ('queued', 'running', 'waiting')
                ) THEN
                    next_status := NULL;
                    IF saw_indet THEN
                        next_status := 'indeterminate';
                    ELSIF saw_failed THEN
                        next_status := 'failed';
                    ELSIF saw_canceled THEN
                        next_status := 'canceled';
                    ELSIF saw_success OR saw_skipped THEN
                        next_status := 'succeeded';
                    END IF;
                    IF next_status IS NOT NULL THEN
                        UPDATE executions
                           SET status = next_status,
                               finished_at = COALESCE(finished_at, now()),
                               updated_at = now()
                         WHERE id = run.id
                           AND workspace_id = app.current_workspace_id()
                           AND status IN ('queued', 'running', 'waiting');
                    END IF;
                END IF;

                -- Pending approvals whose latest gate is no longer waiting.
                -- The execution row is already locked. The approval write
                -- follows it.
                WITH latest_gate AS (
                    SELECT DISTINCT ON (s.node_id)
                           s.node_id,
                           s.status AS step_status,
                           COALESCE(s.error_redacted->>'code', '') AS error_code
                      FROM execution_steps s
                     WHERE s.workspace_id = app.current_workspace_id()
                       AND s.execution_id = run.id
                       AND s.node_type = 'flow.approval'
                     ORDER BY s.node_id, s.attempt DESC
                ),
                closed AS (
                    UPDATE approvals a
                       SET status = CASE
                               WHEN g.error_code = 'workflow_deleted'
                                 OR g.step_status = 'canceled'
                                 OR e.status = 'canceled' THEN 'canceled'
                               ELSE 'expired'
                           END,
                           close_reason = CASE
                               WHEN g.error_code = 'workflow_deleted'
                                 OR (w.deleted_at IS NOT NULL AND (g.step_status = 'canceled' OR e.status = 'canceled'))
                                 THEN 'workflow_deleted'
                               WHEN g.step_status = 'canceled' OR e.status = 'canceled' THEN 'run_canceled'
                               ELSE NULL
                           END,
                           decided_by = NULL,
                           decided_at = NULL,
                           updated_at = now()
                      FROM latest_gate g
                      JOIN executions e
                        ON e.workspace_id = app.current_workspace_id()
                       AND e.id = run.id
                      JOIN workflows w
                        ON w.workspace_id = e.workspace_id
                       AND w.id = e.workflow_id
                     WHERE a.workspace_id = app.current_workspace_id()
                       AND a.workspace_id = e.workspace_id
                       AND a.execution_id = run.id
                       AND a.node_id = g.node_id
                       AND a.status = 'pending'
                       AND g.step_status <> 'waiting'
                    RETURNING a.workspace_id, a.id, a.status, a.close_reason
                )
                INSERT INTO approval_events (workspace_id, approval_id, event_type, actor_id, details, occurred_at)
                SELECT workspace_id,
                       id,
                       CASE WHEN status = 'canceled' THEN 'canceled' ELSE 'expired' END,
                       NULL,
                       CASE
                           WHEN status = 'canceled' THEN jsonb_build_object('reason', close_reason)
                           ELSE '{"reason":"gate_expired"}'::jsonb
                       END,
                       now()
                  FROM closed;
            END LOOP;
        END LOOP;
    END LOOP;
    PERFORM app.set_workspace_id(NULL);
END;
$$;

REVOKE ALL ON FUNCTION app.backfill_settle_stuck_runs() FROM PUBLIC;

SELECT app.backfill_settle_stuck_runs();
