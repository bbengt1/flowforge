# Workflow draft slug backfill

A workflow's slug is fixed when the workflow is created. The API writes
that stored slug into `metadata.slug` on every draft save and every
restore, so the draft YAML always agrees with it. Drafts saved by older
releases can still carry a different `metadata.slug`, or none.
`slug-backfill` rewrites those drafts once. You do not need it for
drafts written after the upgrade.

## What it changes

- Only drafts of live workflows where the parsed `metadata.slug` differs
  from the stored slug, including a missing slug.
- It uses the draft save path: one transaction per draft, the row locked
  with `SELECT ... FOR UPDATE`, and the YAML, digest, and parsed copy
  written together from one normalization. The draft revision goes up, so
  an editor that is open on that draft gets a revision conflict and
  reloads. The last editor (`updated_by`) is kept.
- It never touches published versions (history is immutable) or the
  drafts of soft-deleted workflows. A draft whose YAML no longer parses is
  counted as skipped and left as it is.
- A second run changes 0 drafts.

## Scope and role

The command takes no flags. It runs for one workspace per call, named by
`FLOWFORGE_WORKSPACE_ID`. That value only sets the session setting
`app.workspace_id`. Every connection assumes the request role
`flowforge_app` (no `SUPERUSER`, no `BYPASSRLS`), so FORCE row-level
security limits every read and write to that workspace. No query takes a
workspace argument. The command refuses to run when the session role
could bypass row-level security. Like `migrate`, it connects with
`DATABASE_URL` (or the `POSTGRES_*` parts) and applies pending migrations
first. It needs no other API secret.

Output is counts only, never YAML:

```text
workspace=<uuid>
scanned=<drafts of live workflows in the workspace>
changed=<drafts rewritten>
skipped=<drafts left alone because the YAML does not parse>
```

Exit status is 0 on success, 1 on an error, and 2 when arguments are
passed.

## Local compose

Rebuild the API image so it contains `/usr/local/bin/slug-backfill`,
then find the workspace id and run the command in the `api` container.
`DATABASE_URL` is already set there.

```sh
docker compose up -d --build api
docker compose exec postgres psql -U flowforge -d flowforge \
  -c "SELECT w.id, t.slug AS tenant, w.workbench_key FROM workspaces w JOIN tenants t ON t.id = w.tenant_id"
docker compose exec -e FLOWFORGE_WORKSPACE_ID=<workspace uuid> api /usr/local/bin/slug-backfill
docker compose exec -e FLOWFORGE_WORKSPACE_ID=<workspace uuid> api /usr/local/bin/slug-backfill
```

The second run prints `changed=0`.

## Kubernetes

Run the same binary from the API image with the API Secret's
`DATABASE_URL`, once per workspace, for example as a one-off Job or
`kubectl exec` into an API pod with `FLOWFORGE_WORKSPACE_ID` set.
