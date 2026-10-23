-- E3.5: per-item onError may end a step as succeededWithErrors when some
-- items routed and others succeeded. Item rows gain a terminal status so
-- lease loss can mark in-flight unknown items indeterminate (never
-- auto-retried). Existing item rows are succeeded. unknown is the
-- in-flight marker for a future provider perItem batch writer; pure core
-- nodes still write succeeded in one shot.
-- Forward-only, no down script (repo convention).

ALTER TABLE execution_steps DROP CONSTRAINT IF EXISTS execution_steps_status_check;
ALTER TABLE execution_steps ADD CONSTRAINT execution_steps_status_check CHECK (status IN (
    'pending', 'queued', 'running', 'waiting', 'succeeded', 'succeededWithErrors',
    'failed', 'canceled', 'indeterminate', 'skipped'
));

ALTER TABLE execution_step_items
    ADD COLUMN IF NOT EXISTS status text NOT NULL DEFAULT 'succeeded';

ALTER TABLE execution_step_items DROP CONSTRAINT IF EXISTS execution_step_items_status_check;
ALTER TABLE execution_step_items ADD CONSTRAINT execution_step_items_status_check
    CHECK (status IN ('succeeded', 'failed', 'indeterminate', 'unknown'));
