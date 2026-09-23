# Schema migrations: upgrade, verify, rollback

G.3.5 / #487. Operator runbook for forward-only SQL migrations and
boot-time checksum verification.

Migrations live in `apps/api/migrations` and are embedded in the API,
runner, and `migrate` binaries. PostgreSQL records each applied file in
`schema_migrations`. The process checks those checksums before it
serves traffic.

## Hard lines

- Applied migration files are immutable. A checksum mismatch refuses
  boot. Do not edit `schema_migrations` to match a changed file.
- The refusal names the version, the migration name, and the filename.
  It does not include SQL, credentials, or connection strings.
- Drafts never run. This check does not execute workflows.
- `FORCE RLS` is unchanged. Checksums are schema bookkeeping, not
  workspace data.
- Vault responses stay display-name + UUID. This runbook does not
  change them.

## What is recorded

| Column | Meaning |
| --- | --- |
| `version` | Numeric prefix of `NNNNNN_name.sql`. Primary key. |
| `name` | The description segment of the filename. |
| `applied_at` | When that version committed. |
| `checksum` | Lowercase hex SHA-256 of the exact file bytes (including newlines). |

The runner creates the table and adds `checksum` on databases that
predate this check (`ALTER TABLE … ADD COLUMN IF NOT EXISTS`). New
applies insert the checksum in the same transaction as the SQL. A row
left from an older release has `checksum` NULL until the first boot of
this release stamps it from the file in that binary. A stamp never
overwrites a checksum that is already set.

Concurrent boots take advisory lock `881726401` on one session, then
verify, stamp, and apply. The application pool is not published until
that returns success. Readiness stays `503` until then. Liveness
(`GET /api/v1/health`) can still be `200`: the process is up and is
not serving application traffic.

## Upgrade (apply)

1. Build or pull the image whose embedded migrations are the files you
   intend to apply. Those files are the source of truth, not a copy
   edited on the server.
2. Take a backup before a production migrate
   ([retention and backup](retention-backup.md)).
3. Apply by booting the API or runner, or by running the migrate
   binary (`cmd/migrate`, image entrypoint equivalent). The same
   function runs in each path.
4. Pending versions run in order, each in its own transaction, and the
   checksum is recorded only if that transaction commits.
5. Confirm success:
   - `GET /api/v1/readiness` is `200` `{"status":"ready",…}`, and
   - `cmd/migrate` logged `migrations applied` and exited 0, and
   - every applied row has a 64-character checksum:

```sql
SELECT version, name, checksum
FROM schema_migrations
ORDER BY version;
```

Compare a checksum with the file in the **same** image or git
revision (whitespace matters):

```bash
sha256sum apps/api/migrations/000001_foundation.sql
```

The first boot after this release stamps NULL checksums from the files
inside that binary. Ship that boot from the revision that last migrated
the database. Later edits to those files are drift.

Re-running migrate on an unchanged tree is a no-op.

## Verify on boot

On every boot, after the advisory lock and before new SQL:

1. Load each `*.sql` file and hash its bytes.
2. Read `schema_migrations`.
3. Refuse boot when a recorded version has no file, the filename
   description does not match, or the recorded checksum does not match
   the file.
4. Stamp checksums that are still NULL or empty, only when the name
   matches the file. This does not run when step 3 failed.
5. Apply versions that are not recorded yet.

`cmd/migrate` exits 1 on refusal. The API and runner log
`refusing boot` once at error level and do **not** retry it as a
database outage. They do not open the application pool. Readiness
stays `503` with the public detail `PostgreSQL is not reachable`
(the checksums stay in the log, not in the probe body). Restart is
required after the file is fixed; a corrected embedded file only
arrives in a new process.

## Refused boot

The log line looks like this (version, name, and digests vary):

```text
refusing boot: migration checksum drift for version 12 (kubernetes_read, file 000012_kubernetes_read.sql): recorded sha256 <recorded> does not match the migration file in this binary (sha256 <actual>). Restore that file from the release that applied it (do not edit applied SQL or schema_migrations) and restart. See docs/operations/schema-migrations.md#refused-boot
```

A deleted file or a renamed description is the same refusal, with the
version and the filename to restore. The log says “in this binary”
because the SQL is embedded at build time; restoring the file means
shipping the image built from that file.

### Recover

1. Read the version and filename from the log. Do not paste connection
   strings or vault material into the ticket. The SHA-256 digests are
   not secrets.
2. Do not `UPDATE schema_migrations` to the new digest. That blesses
   the tampered file and hides the drift.
3. Do not edit the applied `.sql` to match the database.
4. Restore that file from the git revision or image that applied it.
   The recorded digest is the SHA-256 of those bytes.
5. Redeploy that image (or roll the Deployment back to it) and restart.
   Boot succeeds only when every applied file matches.
6. If a database restore is paired with a newer binary, and the newer
   binary's embedded file differs, roll the binary back to the release
   whose files match `schema_migrations`, or restore both the database
   and the binary from the same release. Then fix forward with a **new**
   migration. Do not rewrite the applied file.

A missing migration file uses the same steps: put the named file back,
restart.

## Rollback

There are no down migrations. Rolling an application image back does
not undo schema.

Safe application rollback:

- The previous image still contains every applied migration file,
  byte for byte, including checksums.
- That image's code tolerates the schema the database already has.

Unsafe application rollback (boot refuses, or the old code mis-reads
new columns):

- The previous image is missing a version the database has applied
  (the file is absent → refused boot).
- The previous image contains a different body for an applied version
  (checksum drift → refused boot).

Use expand/contract so a rollback stays in the safe case:

1. **Expand.** Ship a forward migration that only adds objects (new
   table, nullable column, new index). Deploy it. Old and new code can
   both run.
2. **Use.** Ship application code that writes the new shape. Keep
   reading the old shape until every replica is on this release.
3. **Contract.** In a later release, stop reading the old shape, then
   ship a new migration that drops it. Do not drop an object in the
   same release that still reads it.

To undo a release that already applied a migration:

- Prefer rolling the application back only when the expand rules above
  hold, and leave the new schema in place.
- To return the database to the pre-migration bytes, restore the backup
  taken before the migrate ([retention and backup](retention-backup.md))
  and boot the previous image against that restore. Do not delete rows
  from `schema_migrations` to fake a rollback.

## Local check

From `apps/api`, with `TEST_DATABASE_URL` or `DATABASE_URL` pointed at a
disposable database:

```bash
go test ./internal/postgres/ -count=1 -run 'TestCleanTreeChecksumVerificationSucceeds|TestChecksumDriftRefusesBoot|TestMigrateChecksumHappyPathAndDrift|TestStartRefusesBootOnChecksumDrift'
```

The clean-tree and drift tests run without a database. The happy-path
and refused-boot tests skip unless a database URL is set. CI runs the
database-free tests on every API change (`go test ./...`).
