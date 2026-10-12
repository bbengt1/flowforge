-- #668: a run that ends (any terminal status other than cancel or
-- workflow delete) while a flow.approval gate is still waiting closes the
-- gate's pending approval in the same close-out transaction with
-- close_reason run_ended. Status stays canceled, with no decider.
--
-- Widens the close-reason check and lets app.close_pending_approvals take
-- run_ended. The function now locks the pending rows ORDER BY id FOR
-- UPDATE before it updates them, so every caller takes approval locks in
-- id order, after execution, job and step locks.

ALTER TABLE approvals DROP CONSTRAINT IF EXISTS approvals_close_reason_check;
ALTER TABLE approvals ADD CONSTRAINT approvals_close_reason_check CHECK (
    (status = 'canceled' AND close_reason IN ('run_canceled', 'workflow_deleted', 'requirement_unresolvable', 'run_ended'))
    OR (status <> 'canceled' AND close_reason IS NULL)
);

CREATE OR REPLACE FUNCTION app.close_pending_approvals(p_execution uuid, p_reason text, p_now timestamptz)
RETURNS integer
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
DECLARE
    n integer := 0;
BEGIN
    IF p_reason IS NULL OR p_reason NOT IN ('run_canceled', 'workflow_deleted', 'run_ended') THEN
        RAISE EXCEPTION 'invalid approval close reason' USING ERRCODE = '22023';
    END IF;
    PERFORM 1 FROM approvals
     WHERE execution_id = p_execution AND status = 'pending'
     ORDER BY id
       FOR UPDATE;
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
