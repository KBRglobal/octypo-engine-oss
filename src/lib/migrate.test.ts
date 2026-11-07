import { describe, it, expect, vi } from 'vitest';

// migrate.ts imports the db module, which throws at import time without a
// connection string. The decision logic under test needs no connection.
vi.mock('../db.js', () => ({ db: {}, client: {} }));

const { decideMigrationAction, BASELINE_TAG } = await import('./migrate.js');

/**
 * The engine ran on `drizzle-kit push` with no migration files, so a schema
 * change reached production only if someone remembered to push it by hand.
 * That already broke `GET /api/admin/articles` in production once, when
 * `scheduled_for` existed in the schema and not in the database.
 *
 * Introducing migrations has one hazard: the baseline migration creates every
 * table with plain `CREATE TABLE`, so running it against the live database
 * would fail on the first one. An existing database must therefore be recorded
 * as already at the baseline rather than migrated up to it.
 */
describe('migration decision', () => {
  it('runs everything on an empty database', () => {
    expect(decideMigrationAction({ hasMigrationsTable: false, hasEngineTables: false })).toBe('migrate');
  });

  it('stamps a database that predates migrations instead of recreating its tables', () => {
    expect(decideMigrationAction({ hasMigrationsTable: false, hasEngineTables: true })).toBe('baseline');
  });

  it('migrates normally once the ledger exists', () => {
    expect(decideMigrationAction({ hasMigrationsTable: true, hasEngineTables: true })).toBe('migrate');
  });

  it('migrates when the ledger exists but the tables were dropped', () => {
    // Recreating from an empty database with a ledger present is drizzle's own
    // problem to report; we must not silently stamp over it.
    expect(decideMigrationAction({ hasMigrationsTable: true, hasEngineTables: false })).toBe('migrate');
  });

  it('names the baseline migration that a stamp records', () => {
    expect(BASELINE_TAG).toBe('0000_baseline');
  });
});
