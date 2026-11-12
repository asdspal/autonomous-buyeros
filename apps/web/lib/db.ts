import { Pool } from 'pg';

let pool: Pool | null = null;

export function getPool(): Pool {
  if (!pool) {
    const connectionString = process.env.DATABASE_URL;
    if (!connectionString) throw new Error('DATABASE_URL is not set');
    pool = new Pool({
      connectionString,
      max: 2,
      connectionTimeoutMillis: 500,
      idleTimeoutMillis: 10_000,
    });
  }
  return pool;
}

export async function pingDatabase(timeoutMs = 500): Promise<'up' | 'down'> {
  const timeout = new Promise<'down'>((resolve) => {
    setTimeout(() => resolve('down'), timeoutMs).unref();
  });
  const query = getPool()
    .query('SELECT 1')
    .then(() => 'up' as const)
    .catch(() => 'down' as const);
  return Promise.race([query, timeout]);
}
