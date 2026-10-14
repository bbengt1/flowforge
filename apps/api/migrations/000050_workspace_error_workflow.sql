-- #649 S3: workspace error workflow.
--
-- workspaces.error_workflow_id names the workspace's error workflow. The
-- composite FK keeps the target in the same workspace. There is no
-- ON DELETE SET NULL: workflows are soft-deleted, so the reference stays
-- and the engine skips (and audits) a deleted, unpublished or archived
-- target at fire time.
--
-- executions.error_parent_id links an error-workflow run to the failed or
-- indeterminate run that fired it. The composite FK forbids a parent in
-- another workspace; the partial unique index fires at most once per
-- parent. When retention purges the parent only error_parent_id is
-- cleared (workspace_id stays). error_fired_at stamps the parent when it
-- fired. operator_retried_at marks a run an operator retried: such a run
-- never fires the error workflow.
--
-- Forward-only, no down script (repo convention).

ALTER TABLE workspaces
    ADD COLUMN error_workflow_id uuid;

ALTER TABLE workspaces
    ADD CONSTRAINT workspaces_error_workflow_fk
        FOREIGN KEY (id, error_workflow_id)
        REFERENCES workflows (workspace_id, id);

ALTER TABLE executions
    ADD COLUMN error_parent_id uuid,
    ADD COLUMN error_fired_at timestamptz,
    ADD COLUMN operator_retried_at timestamptz;

ALTER TABLE executions
    ADD CONSTRAINT executions_error_parent_fk
        FOREIGN KEY (workspace_id, error_parent_id)
        REFERENCES executions (workspace_id, id)
        ON DELETE SET NULL (error_parent_id);

CREATE UNIQUE INDEX executions_error_parent_unique
    ON executions (workspace_id, error_parent_id)
    WHERE error_parent_id IS NOT NULL;

-- Hard delete and tenant purge clear the setting first. The app only
-- soft-deletes workflows, but an operator hard DELETE of a workflow (or a
-- workspace/tenant purge that cascades to workflows) must not be blocked
-- by, or leave behind, workspaces.error_workflow_id. A BEFORE DELETE row
-- trigger on workflows clears the reference that names the dying row.
-- SECURITY DEFINER so it works under FORCE RLS for the deleting role; it
-- only touches the row whose id/workspace match OLD.
CREATE FUNCTION workflows_clear_error_workflow() RETURNS trigger
    LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
BEGIN
    UPDATE public.workspaces
       SET error_workflow_id = NULL
     WHERE id = OLD.workspace_id
       AND error_workflow_id = OLD.id;
    RETURN OLD;
END;
$$;

CREATE TRIGGER workflows_clear_error_workflow
    BEFORE DELETE ON workflows
    FOR EACH ROW EXECUTE FUNCTION workflows_clear_error_workflow();
