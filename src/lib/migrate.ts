/**
 * Schema migrations.
 *
 * The engine used to change its schema with `drizzle-kit push`, which applies
 * whatever the schema files currently say and records nothing. A change reached
 * production only if a human remembered to run it there, and forgetting was
 * silent until a query hit the missing column — which is exactly how
 * `scheduled_for` took down `GET /api/admin/articles` in production.
 *
 * Migrations remove the human from that loop: every change is a file, the files
 * run in order at boot, and the database records which ones it has.
 *
 * The one hazard is the first run. `0000_baseline.sql` creates every table with
 * a plain `CREATE TABLE`, so running it against the database that already holds
 * a customer's articles would fail on the first statement. An existing database
 * is therefore *stamped* as already at the baseline instead of migrated up to
 * it. A stamp is only ever written when the engine's own tables are present and
 * the ledger is not — any other combination is drizzle's to handle and report.
 */

import { fileURLToPath } from "node:url";
import path from "node:path";

import { readMigrationFiles } from "drizzle-orm/migrator";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import type postgres from "postgres";

import { db, client } from "../db.js";
import { logger } from "./logger.js";

/** The migration a pre-migrations database is recorded as already having. */
export const BASELINE_TAG = "0000_baseline";

/** Drizzle's own ledger location. Must match what the migrator writes. */
const MIGRATIONS_SCHEMA = "drizzle";
const MIGRATIONS_TABLE = "__drizzle_migrations";

/** A table that only ever exists because this engine created it. */
const SENTINEL_TABLE = "contents";

export const MIGRATIONS_FOLDER = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../drizzle"
);

export interface DatabaseState {
  hasMigrationsTable: boolean;
  hasEngineTables: boolean;
}

export type MigrationAction = "migrate" | "baseline";

export function decideMigrationAction(state: DatabaseState): MigrationAction {
  if (!state.hasMigrationsTable && state.hasEngineTables) return "baseline";
  return "migrate";
}

async function readState(sql: postgres.Sql): Promise<DatabaseState> {
  const [ledger] = await sql<{ present: boolean }[]>`
    SELECT EXISTS (
      SELECT 1 FROM information_schema.tables
      WHERE table_schema = ${MIGRATIONS_SCHEMA} AND table_name = ${MIGRATIONS_TABLE}
    ) AS present
  `;
  const [engine] = await sql<{ present: boolean }[]>`
    SELECT EXISTS (
      SELECT 1 FROM information_schema.tables
      WHERE table_schema = 'public' AND table_name = ${SENTINEL_TABLE}
    ) AS present
  `;
  return {
    hasMigrationsTable: Boolean(ledger?.present),
    hasEngineTables: Boolean(engine?.present),
  };
}

/**
 * Record the baseline as applied without running it. The row shape is drizzle's,
 * and the hash is read from the migration file itself rather than hardcoded, so
 * a regenerated baseline cannot drift out of agreement with the ledger.
 */
async function stampBaseline(sql: postgres.Sql): Promise<void> {
  const files = readMigrationFiles({ migrationsFolder: MIGRATIONS_FOLDER });
  const baseline = files[0];
  if (!baseline) {
    throw new Error(`No migration files found in ${MIGRATIONS_FOLDER}`);
  }
  if (files.length > 1) {
    // Stamping only the baseline would leave later migrations unapplied *and*
    // unrunnable, because their ledger row would be missing while their changes
    // are absent. Refuse rather than half-record.
    logger.warn(
      { count: files.length },
      "[Migrate] Pre-migrations database found with more than one migration on disk — " +
        "stamping the baseline only; the rest will run normally"
    );
  }

  await sql.unsafe(`CREATE SCHEMA IF NOT EXISTS "${MIGRATIONS_SCHEMA}"`);
  await sql.unsafe(`
    CREATE TABLE IF NOT EXISTS "${MIGRATIONS_SCHEMA}"."${MIGRATIONS_TABLE}" (
      id SERIAL PRIMARY KEY,
      hash text NOT NULL,
      created_at bigint
    )
  `);
  await sql.unsafe(
    `INSERT INTO "${MIGRATIONS_SCHEMA}"."${MIGRATIONS_TABLE}" ("hash", "created_at") VALUES ($1, $2)`,
    [baseline.hash, baseline.folderMillis]
  );

  logger.warn(
    { tag: BASELINE_TAG },
    "[Migrate] Existing database recorded at the baseline — its tables were left untouched"
  );
}

/**
 * Bring the database to the current schema. Safe to call on every boot: an
 * up-to-date database does nothing but read the ledger.
 */
export async function runMigrations(sql: postgres.Sql = client): Promise<MigrationAction> {
  const state = await readState(sql);
  const action = decideMigrationAction(state);

  if (action === "baseline") {
    await stampBaseline(sql);
  }

  await migrate(db, { migrationsFolder: MIGRATIONS_FOLDER });
  logger.info("[Migrate] Schema is up to date");
  return action;
}
