import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';
import * as schema from './schema';

// DATABASE_URL is expected to be a Postgres connection string. Works with a
// local Postgres for dev and with Neon's pooled connection string in
// production (Neon is wire-compatible with node-postgres).
//
// The connection is created lazily, on first query, rather than at import
// time. `next build` imports every route handler module to collect page
// data, and that must succeed even when DATABASE_URL is not set (e.g. CI
// running only `npm run build` without a database); the error should
// surface when a request actually tries to touch the database, not before.
let cached: NodePgDatabase<typeof schema> | null = null;

function getDb(): NodePgDatabase<typeof schema> {
  if (cached) return cached;

  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) {
    throw new Error('DATABASE_URL is not set. Copy .env.example to .env and fill it in.');
  }

  const pool = new Pool({ connectionString });
  cached = drizzle(pool, { schema });
  return cached;
}

export const db: NodePgDatabase<typeof schema> = new Proxy({} as NodePgDatabase<typeof schema>, {
  get(_target, prop, receiver) {
    return Reflect.get(getDb(), prop, receiver);
  },
});
