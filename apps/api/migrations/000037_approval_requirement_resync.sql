-- Pending approval resync.
--
-- Fallback rows stored approver_role approver and dropped the gate's
-- target user or group and policy pin. Boot resync corrects those rows
-- in Go, as flowforge_app, one workspace transaction at a time, under
-- FORCE RLS. This migration only widens the close-reason check and
-- adds the subject columns. It does not set row_security off and does
-- not grant BYPASSRLS.
--
-- A row whose pinned version cannot be rebuilt is canceled with
-- close_reason requirement_unresolvable and no decider. run_canceled
-- and workflow_deleted stay the only reasons app.close_pending_approvals
-- accepts.

ALTER TABLE approvals ADD COLUMN IF NOT EXISTS approver_user_id uuid;
ALTER TABLE approvals ADD COLUMN IF NOT EXISTS approver_group_id uuid;

ALTER TABLE approvals DROP CONSTRAINT IF EXISTS approvals_close_reason_check;
ALTER TABLE approvals ADD CONSTRAINT approvals_close_reason_check CHECK (
    (status = 'canceled' AND close_reason IN ('run_canceled', 'workflow_deleted', 'requirement_unresolvable'))
    OR (status <> 'canceled' AND close_reason IS NULL)
);
