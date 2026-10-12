-- Run status succeededWithErrors: the run finished and every failed step was
-- handled by onError (continue or errorOutput). Terminal, like succeeded.
-- Forward-only, no down script (repo convention).

ALTER TABLE executions DROP CONSTRAINT IF EXISTS executions_status_check;
ALTER TABLE executions ADD CONSTRAINT executions_status_check CHECK (status IN (
    'queued', 'pinned', 'running', 'waiting', 'succeeded', 'succeededWithErrors', 'failed', 'canceled', 'indeterminate'
));
