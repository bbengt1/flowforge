-- ADV-019: revoke embed-bound browser sessions when a workspace is
-- soft-disabled (status=disabled) or hard-deleted. browser_sessions is
-- identity substrate (no RLS). Soft-delete keeps embed binding for
-- forensics. Hard-delete clears the embed tenancy columns so
-- ON DELETE SET NULL on embed_workspace_id cannot leave a partial
-- (tenant, workbench) row that violates browser_sessions_embed_tenancy_check.

CREATE OR REPLACE FUNCTION app.revoke_sessions_for_workspace()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
    UPDATE browser_sessions
       SET revoked_at = COALESCE(revoked_at, now()),
           last_seen_at = now()
     WHERE revoked_at IS NULL
       AND (
           embed_workspace_id = OLD.id
           OR (
               embed_tenant_id = OLD.tenant_id
               AND embed_workbench_key = OLD.workbench_key
           )
       );

    IF TG_OP = 'DELETE' THEN
        UPDATE browser_sessions
           SET embed_tenant_id = NULL,
               embed_workbench_key = NULL,
               embed_workspace_id = NULL
         WHERE embed_workspace_id = OLD.id
            OR (
                embed_tenant_id = OLD.tenant_id
                AND embed_workbench_key = OLD.workbench_key
            );
        RETURN OLD;
    END IF;
    RETURN NEW;
END;
$$;

CREATE TRIGGER workspaces_revoke_sessions_on_disable
    BEFORE UPDATE OF status ON workspaces
    FOR EACH ROW
    WHEN (NEW.status = 'disabled' AND OLD.status IS DISTINCT FROM NEW.status)
    EXECUTE FUNCTION app.revoke_sessions_for_workspace();

CREATE TRIGGER workspaces_revoke_sessions_on_delete
    BEFORE DELETE ON workspaces
    FOR EACH ROW
    EXECUTE FUNCTION app.revoke_sessions_for_workspace();
