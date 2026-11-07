/**
 * `npm run db:migrate` — apply migrations and exit.
 *
 * Boot does this too, so this exists for the cases where boot is the wrong
 * moment: checking a database before a deploy, or migrating a customer's
 * database from a machine that is not running the engine.
 */

import "dotenv/config";
import { closeDb } from "../db.js";
import { logger } from "../lib/logger.js";
import { runMigrations } from "../lib/migrate.js";

try {
  const action = await runMigrations();
  logger.info({ action }, "[Migrate] Done");
  await closeDb();
  process.exit(0);
} catch (error) {
  logger.error({ error }, "[Migrate] Failed");
  await closeDb().catch(() => undefined);
  process.exit(1);
}
