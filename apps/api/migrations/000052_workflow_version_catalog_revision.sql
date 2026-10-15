-- #650 E3.2: record the catalog revision a version was published against.
--
-- catalog.APIVersion stays flowforge/v1; catalogRevision versions node
-- semantics inside it (DESIGN-650 §7, §9b #6). Publish stores it from E3.2
-- on, when publish starts recording FFX expression semantics. The column is
-- NULL for every version published before this migration (legacy
-- semantics, pinned by digest); there is no backfill. workflow_versions
-- stays immutable: the 000005 trigger still refuses UPDATE and DELETE, and
-- the value is only ever written by the publish INSERT.
--
-- Forward-only, no down script (repo convention).

ALTER TABLE workflow_versions
    ADD COLUMN catalog_revision integer
        CHECK (catalog_revision IS NULL OR catalog_revision BETWEEN 1 AND 1000000);
