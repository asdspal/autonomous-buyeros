#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { Client } from 'pg';

function arg(name, fallback) {
  const index = process.argv.indexOf(`--${name}`);
  return index === -1 ? fallback : process.argv[index + 1];
}

const databaseUrl = arg('database-url', process.env.DATABASE_URL);
if (!databaseUrl) {
  console.error('missing --database-url or DATABASE_URL');
  process.exit(1);
}

const migrationsDir = path.resolve(process.cwd(), arg('dir', 'db/migrations'));
const files = readdirSync(migrationsDir)
  .filter((file) => file.endsWith('.sql'))
  .sort();

const client = new Client({ connectionString: databaseUrl });
await client.connect();

try {
  await client.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      name        TEXT PRIMARY KEY,
      sha256      TEXT NOT NULL,
      applied_at  TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `);

  for (const file of files) {
    const sql = readFileSync(path.join(migrationsDir, file), 'utf8');
    const hash = createHash('sha256').update(sql).digest('hex');
    const existing = await client.query(
      'SELECT sha256 FROM schema_migrations WHERE name = $1',
      [file],
    );
    if (existing.rowCount) {
      if (existing.rows[0].sha256 !== hash) {
        console.error(`refusing: ${file} changed after it was applied`);
        process.exit(2);
      }
      console.log(`skip   ${file}`);
      continue;
    }

    console.log(`apply  ${file}`);
    await client.query('BEGIN');
    try {
      await client.query(sql);
      await client.query(
        'INSERT INTO schema_migrations (name, sha256) VALUES ($1, $2)',
        [file, hash],
      );
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    }
  }

  const { rows } = await client.query(`
    SELECT count(*)::int AS migrations FROM schema_migrations;
    `);
  const tables = await client.query(`
    SELECT count(*)::int AS tables FROM information_schema.tables
    WHERE table_schema = 'public' AND table_type = 'BASE TABLE'
      AND table_name <> 'schema_migrations'`);
  console.log(`done: ${rows[0].migrations} migrations, ${tables.rows[0].tables} tables`);
} finally {
  await client.end();
}
