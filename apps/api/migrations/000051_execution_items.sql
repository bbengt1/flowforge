-- #650 E3.1: item model storage.
--
-- execution_step_items holds one redacted object per (step, port, idx).
-- There is no attempt column: each retry attempt already has its own
-- execution_steps row. There is no execution_id column: it comes through
-- the step, so it cannot drift. The composite FK keeps an item in its
-- step's workspace, and ON DELETE CASCADE takes items with their step
-- (retention purge, workspace hard delete, tenant purge). Item rows are
-- never truncated; an oversize item fails the step before insert.
--
-- executions.item_bytes is the per-run item budget (64 MiB). It is only
-- updated under the executions row lock (lockExecutionTx), so concurrent
-- steps cannot go over the cap.
--
-- FORCE RLS through the 000003 helper. No BYPASSRLS. The app role gets
-- SELECT/INSERT/DELETE only: item rows are immutable once written.
--
-- Forward-only, no down script (repo convention).

CREATE TABLE execution_step_items (
    workspace_id  uuid   NOT NULL,
    step_id       uuid   NOT NULL,
    port          text   NOT NULL,
    idx           int    NOT NULL,
    item_redacted jsonb  NOT NULL,
    bytes         int    NOT NULL,
    lineage       jsonb  NOT NULL,
    PRIMARY KEY (workspace_id, step_id, port, idx),
    FOREIGN KEY (workspace_id, step_id) REFERENCES execution_steps (workspace_id, id) ON DELETE CASCADE,
    CHECK (char_length(port) BETWEEN 1 AND 128),
    CHECK (idx >= 0 AND idx < 1000),
    CHECK (bytes >= 0 AND bytes <= 16384),
    CHECK (jsonb_typeof(item_redacted) = 'object'),
    CHECK (jsonb_typeof(lineage) = 'object')
);

SELECT app.enable_workspace_isolation('execution_step_items');

GRANT SELECT, INSERT, DELETE ON execution_step_items TO flowforge_app;

ALTER TABLE executions
    ADD COLUMN item_bytes bigint NOT NULL DEFAULT 0
        CHECK (item_bytes >= 0 AND item_bytes <= 67108864);

-- Write-once marker for a step's items (set in the same transaction as the
-- item rows and summary). Tracked here, not in output_redacted keys, so a
-- node's own output fields never collide with the items summary.
ALTER TABLE execution_steps
    ADD COLUMN items_written_at timestamptz;
