/**
 * Migration rollback smoke test.
 *
 * Applies a canary migration to a disposable Postgres schema, verifies the
 * table/index exist, then runs the corresponding down SQL and confirms they
 * are gone.  The test is skipped automatically when DATABASE_URL is unset so
 * it does not block unit-test runs that have no database.
 *
 * Run locally:
 *   DATABASE_URL=postgresql://... npx vitest run src/__tests__/migration-rollback.smoke.test.ts
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { Client } from "pg";

const DATABASE_URL = process.env.DATABASE_URL;
const SCHEMA = `rollback_smoke_${Date.now()}`;

const UP_SQL = `
  CREATE SCHEMA IF NOT EXISTS "${SCHEMA}";
  CREATE TABLE "${SCHEMA}".rollback_canary (
    id         SERIAL PRIMARY KEY,
    name       TEXT        NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
  );
  CREATE INDEX idx_rollback_canary_name
    ON "${SCHEMA}".rollback_canary (name);
`;

const DOWN_SQL = `
  DROP INDEX  IF EXISTS "${SCHEMA}".idx_rollback_canary_name;
  DROP TABLE  IF EXISTS "${SCHEMA}".rollback_canary;
  DROP SCHEMA IF EXISTS "${SCHEMA}" CASCADE;
`;

async function objectExists(
  client: Client,
  query: string,
  params: string[]
): Promise<boolean> {
  const res = await client.query(query, params);
  return res.rowCount !== null && res.rowCount > 0;
}

describe.skipIf(!DATABASE_URL)("migration rollback smoke test", () => {
  let client: Client;

  beforeAll(async () => {
    client = new Client({ connectionString: DATABASE_URL });
    await client.connect();
  });

  afterAll(async () => {
    // Always clean up, even if tests fail mid-way.
    await client.query(DOWN_SQL).catch(() => {});
    await client.end();
  });

  it("applies the canary migration (up) — table and index must exist", async () => {
    await client.query(UP_SQL);

    const tableOk = await objectExists(
      client,
      `SELECT 1 FROM information_schema.tables
       WHERE table_schema=$1 AND table_name='rollback_canary'`,
      [SCHEMA]
    );
    expect(tableOk).toBe(true);

    const indexOk = await objectExists(
      client,
      `SELECT 1 FROM pg_indexes
       WHERE schemaname=$1 AND indexname='idx_rollback_canary_name'`,
      [SCHEMA]
    );
    expect(indexOk).toBe(true);
  });

  it("accepts inserts after the up migration", async () => {
    await client.query(
      `INSERT INTO "${SCHEMA}".rollback_canary (name) VALUES ($1)`,
      ["smoke-row"]
    );
    const res = await client.query(
      `SELECT name FROM "${SCHEMA}".rollback_canary WHERE name=$1`,
      ["smoke-row"]
    );
    expect(res.rows[0]?.name).toBe("smoke-row");
  });

  it("reverts the canary migration (down) — table and schema must be gone", async () => {
    await client.query(DOWN_SQL);

    const tableGone = !(await objectExists(
      client,
      `SELECT 1 FROM information_schema.tables
       WHERE table_schema=$1 AND table_name='rollback_canary'`,
      [SCHEMA]
    ));
    expect(tableGone).toBe(true);

    const schemaGone = !(await objectExists(
      client,
      `SELECT 1 FROM information_schema.schemata WHERE schema_name=$1`,
      [SCHEMA]
    ));
    expect(schemaGone).toBe(true);
  });

  it("down migration is idempotent — running it again must not throw", async () => {
    await expect(client.query(DOWN_SQL)).resolves.toBeDefined();
  });
});
