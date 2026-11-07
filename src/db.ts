/**
 * Database client — drizzle over postgres-js
 */

import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import * as schema from "./schema/index.js";
import { log } from "./lib/logger.js";

const databaseUrl = process.env.DATABASE_URL;

if (!databaseUrl) {
  throw new Error("DATABASE_URL must be set (postgres connection string).");
}

const dbHost = new URL(databaseUrl).host;
log.info(`[DB] Connecting to PostgreSQL at ${dbHost}`);

export const client = postgres(databaseUrl, {
  max: 15,
  idle_timeout: 30,
  connect_timeout: 10,
});

export const db = drizzle(client, { schema });

/** Graceful shutdown — close all connections */
export async function closeDb(): Promise<void> {
  await client.end({ timeout: 5 });
}
