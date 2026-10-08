-- SCIM Groups mode (#592 part 2). With SCIM_GROUPS_MODE=groups, a
-- workspace SCIM token manages Flowforge groups in its own workspace.
--
-- external_id is the externalId the identity provider sent on create.
-- It is unique per workspace when set, and it is never rewritten by a
-- rename. managed_by is 'scim' for a group a SCIM token created and NULL
-- for a local group. It is set only on create and never changes, so
-- switching SCIM_GROUPS_MODE back to workspaces keeps the marker (it is
-- simply not enforced) and switching to groups again re-attaches the
-- same rows by id and external_id. No data is lost either way.
--
-- RLS is unchanged: workspace_groups keeps FORCE RLS from 000043, and
-- the new columns are covered by the existing workspace policy. Schema
-- migrations are forward-only, so this file has no down script.

ALTER TABLE workspace_groups
    ADD COLUMN external_id text,
    ADD COLUMN managed_by  text,
    ADD CONSTRAINT workspace_groups_external_id_len
        CHECK (external_id IS NULL OR char_length(external_id) BETWEEN 1 AND 256),
    ADD CONSTRAINT workspace_groups_managed_by_check
        CHECK (managed_by IS NULL OR managed_by = 'scim');

-- One externalId per workspace. The API maps a violation to SCIM 409
-- uniqueness.
CREATE UNIQUE INDEX workspace_groups_external_id_uidx
    ON workspace_groups (workspace_id, external_id)
    WHERE external_id IS NOT NULL;
