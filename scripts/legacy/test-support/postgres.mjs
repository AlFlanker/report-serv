import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';

/** Real PostgreSQL, with a schema owned exclusively by this test. */
export async function postgresFixture(t) {
  const databaseUrl = process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL;
  if (!databaseUrl) throw new Error('PostgreSQL tests require DATABASE_URL; run npm run db:up first.');
  const databaseSchema = `test_${randomUUID().replaceAll('-', '')}`;
  const pool = new Pool({ connectionString: databaseUrl, options: `-c search_path=${databaseSchema}`, max: 2 });
  let closed = false;
  const cleanup = async () => {
    if (closed) return;
    if (!/^test_[a-f0-9]{32}$/.test(databaseSchema)) throw new Error('Refusing to drop a non-test PostgreSQL schema');
    closed = true;
    try { await pool.query(`DROP SCHEMA IF EXISTS "${databaseSchema}" CASCADE`); }
    finally { await pool.end(); }
  };
  try { await pool.query(`CREATE SCHEMA "${databaseSchema}"`); }
  catch (error) { await pool.end(); throw error; }
  t.after(cleanup);
  return { databaseUrl, databaseSchema, query: (text, values) => pool.query(text, values), cleanup };
}
