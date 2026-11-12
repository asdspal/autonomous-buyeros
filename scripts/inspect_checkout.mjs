#!/usr/bin/env node
import { Client } from 'pg';

const args = process.argv.slice(2);
const getArg = (name, fallback) => {
  const index = args.indexOf(name);
  return index === -1 ? fallback : args[index + 1];
};

const databaseUrl = getArg('--database-url', process.env.DATABASE_URL);
const checkoutId = getArg('--checkout', null);
const expect = getArg('--expect', null);

if (!databaseUrl) {
  console.error('missing --database-url or DATABASE_URL');
  process.exit(2);
}

const client = new Client({ connectionString: databaseUrl });
await client.connect();
const where = checkoutId ? 'WHERE c.id = $1' : '';
const params = checkoutId ? [checkoutId] : [];
const { rows } = await client.query(
  `SELECT c.id, c.status, c.total_minor, c.currency, c.correlation_id, c.created_at,
          v.id AS verdict_id, v.decision, v.reason_codes, v.evidence_hash, v.latency_us,
          a.order_id, a.authorization_id, a.status AS authorization_status,
          a.captured_minor
     FROM checkout c
     LEFT JOIN verdict v ON v.checkout_id = c.id
     LEFT JOIN paypal_authorization a ON a.checkout_id = c.id AND a.purpose = 'PURCHASE'
     ${where}
    ORDER BY c.created_at DESC
    LIMIT 1`,
  params,
);
await client.end();

if (!rows.length) {
  console.error('no checkout found');
  process.exit(1);
}
const row = rows[0];
console.log(JSON.stringify(row, null, 2));
if (expect && row.decision !== expect) {
  console.error(`expected decision ${expect}, got ${row.decision}`);
  process.exit(1);
}
