# Database Migration Rollback Runbook

> **Audience:** On-call engineers and backend developers  
> **Applies to:** Nova Launch backend — Prisma + PostgreSQL  
> **Last reviewed:** 2026-05-28

---

## Overview

Prisma does not generate automatic "down" migrations. Every migration file in
`backend/prisma/migrations/` contains only the **up** SQL.  This runbook
describes how to safely revert the most-recently applied migration and how to
handle irreversible operations.

---

## Pre-flight checklist

Before attempting a rollback:

- [ ] Identify the migration to revert (`prisma migrate status` output).
- [ ] Take a point-in-time backup of the production database (see
      [DATABASE_BACKUP_PITR.md](DATABASE_BACKUP_PITR.md)).
- [ ] Verify you can restore from the backup before proceeding.
- [ ] Announce the maintenance window in the incident channel.
- [ ] Confirm the application can tolerate downtime or run in read-only mode
      during the rollback.

---

## Step 1 — Identify the target migration

```bash
cd backend
npx prisma migrate status
```

Note the name of the **latest applied** migration, e.g.
`20260309_add_campaigns`.

---

## Step 2 — Write the down-migration SQL

Prisma does not generate down SQL automatically.  You must write it by hand,
reversing the up SQL found in the relevant `migration.sql` file.

### Common reversals

| Up operation | Down equivalent |
|---|---|
| `CREATE TABLE foo` | `DROP TABLE foo;` |
| `ALTER TABLE foo ADD COLUMN bar` | `ALTER TABLE foo DROP COLUMN bar;` |
| `CREATE INDEX ...` | `DROP INDEX ...;` |
| `ALTER TABLE foo ADD CONSTRAINT ...` | `ALTER TABLE foo DROP CONSTRAINT ...;` |
| `CREATE TYPE ...` | `DROP TYPE ...;` (only if no column references it) |

### Example — reverting `20260309_add_campaigns`

```sql
-- Down migration for 20260309_add_campaigns
ALTER TABLE "CampaignExecution" DROP CONSTRAINT IF EXISTS "CampaignExecution_campaignId_fkey";
DROP TABLE IF EXISTS "CampaignExecution";
DROP TABLE IF EXISTS "Campaign";
DROP TYPE IF EXISTS "CampaignType";
DROP TYPE IF EXISTS "CampaignStatus";
```

Save this as `down_<migration_name>.sql` (do **not** place it inside the
`migrations/` directory — Prisma owns that directory).

---

## Step 3 — Execute the rollback on a disposable copy first

```bash
# Spin up a scratch DB (adjust connection string as needed)
export SCRATCH_DB_URL="postgresql://postgres:postgres@localhost:5433/nova_scratch"

createdb -h localhost -p 5433 -U postgres nova_scratch

# Apply all migrations up to current state
DATABASE_URL="$SCRATCH_DB_URL" npx prisma migrate deploy

# Verify data integrity
DATABASE_URL="$SCRATCH_DB_URL" npx prisma db execute --file seed-integration.ts

# Run the down SQL
psql "$SCRATCH_DB_URL" -f down_<migration_name>.sql

# Confirm the schema looks correct
DATABASE_URL="$SCRATCH_DB_URL" npx prisma db pull --print
```

Resolve any errors before touching the production database.

---

## Step 4 — Apply the rollback to production

```bash
# Connect to the production database
psql "$DATABASE_URL" -f down_<migration_name>.sql
```

---

## Step 5 — Update the Prisma migrations table

Prisma tracks applied migrations in the `_prisma_migrations` table.  After
running the down SQL, mark the reverted migration as rolled-back so Prisma
does not try to re-apply it:

```sql
-- Mark the migration as rolled back (sets applied_steps_count to 0 and
-- records a rollback_started_at timestamp so `migrate status` reflects reality)
UPDATE "_prisma_migrations"
SET
  "rolled_back_at" = now(),
  "applied_steps_count" = 0
WHERE "migration_name" = '<migration_name>';
```

Verify the status:

```bash
npx prisma migrate status
```

---

## Step 6 — Deploy the reverted application code

Roll back the application to the Git commit that predates the migration:

```bash
git revert <commit-sha>   # or checkout the previous release tag
# Re-deploy via your standard CI/CD pipeline
```

---

## Irreversible operations

Some operations **cannot** be safely reversed without data loss:

| Operation | Risk | Mitigation |
|---|---|---|
| `DROP COLUMN` | Data permanently deleted | Restore from backup |
| `DROP TABLE` | All rows lost | Restore from backup |
| `DROP TYPE` | Enum removed from schema | Restore from backup |
| `ALTER COLUMN … USING` (type coercion) | Original values overwritten | Restore from backup |

If the migration you are rolling back contains any of these, **restore from the
pre-migration backup** (see [DATABASE_BACKUP_PITR.md](DATABASE_BACKUP_PITR.md))
instead of running a down-migration script.

---

## Smoke test

A local smoke test that applies then reverts a canary migration is located at:

```
backend/src/__tests__/migration-rollback.smoke.test.ts
```

Run it against a local test database:

```bash
cd backend
DATABASE_URL="postgresql://postgres:postgres@localhost:5432/nova_test" \
  npx vitest run src/__tests__/migration-rollback.smoke.test.ts
```

The test:
1. Creates a disposable schema.
2. Applies the canary migration (`add_rollback_canary`).
3. Confirms the target table/column exists.
4. Runs the corresponding down SQL.
5. Confirms the target table/column no longer exists.
6. Tears down the schema.

---

## Quick reference

```bash
# Check current migration status
npx prisma migrate status

# Apply all pending migrations (production)
npx prisma migrate deploy

# Inspect current DB schema (no writes)
npx prisma db pull --print

# Open a psql session with the configured DATABASE_URL
psql "$DATABASE_URL"
```
