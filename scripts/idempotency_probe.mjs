#!/usr/bin/env node
import { Client } from 'pg';

const args = process.argv.slice(2);
const take = (name, fallback) => {
  const index = args.indexOf(name);
  return index === -1 ? fallback : args[index + 1];
};
const base = take('--url', process.env.DEMO_URL ?? 'http://localhost:3210');
const databaseUrl = take('--database-url', process.env.DATABASE_URL);
if (!databaseUrl) {
  console.error('missing --database-url');
  process.exit(2);
}

async function post(body) {
  const response = await fetch(new URL('/api/checkouts', base), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  const text = await response.text();
  let parsed;
  try {
    parsed = text ? JSON.parse(text) : { raw: '' };
  } catch {
    parsed = { raw: text.slice(0, 300) };
  }
  return { status: response.status, body: parsed };
}

const key = `idem-${Date.now()}-0001`;
console.log('key:', key);
const [a, b] = await Promise.all([post({ requestKey: key }), post({ requestKey: key })]);
console.log('first:', a.status, a.body.checkoutId, '| second:', b.status);
const settled = b.status === 200 ? b : await post({ requestKey: key });
console.log('replay:', settled.status, settled.body.checkoutId);

const reused = await post({ requestKey: key, extra: true });
console.log('reused key, different body:', reused.status, JSON.stringify(reused.body));

const fresh = await post({ requestKey: `${key}-other` });
console.log('different key:', fresh.status, fresh.body.checkoutId);

const db = new Client({ connectionString: databaseUrl });
await db.connect();
const counts = await db.query(
  `SELECT
     (SELECT count(*)::int FROM checkout WHERE request_key = $1) AS checkouts,
     (SELECT count(*)::int FROM paypal_authorization a
        JOIN checkout c ON c.id = a.checkout_id WHERE c.request_key = $1) AS authorizations,
     (SELECT count(*)::int FROM idempotency_record WHERE scope = 'checkout' AND key = $1) AS records,
     (SELECT count(*)::int FROM idempotency_record
        WHERE scope = 'checkout' AND key = $1 AND response_body IS NOT NULL) AS stored_responses`,
  [key],
);
await db.end();
console.log('db:', JSON.stringify(counts.rows[0]));

const ok =
  a.status === 200 &&
  settled.status === 200 &&
  settled.body.checkoutId === a.body.checkoutId &&
  reused.status === 409 &&
  fresh.status === 200 &&
  fresh.body.checkoutId !== a.body.checkoutId &&
  counts.rows[0].checkouts === 1 &&
  counts.rows[0].authorizations === 1 &&
  counts.rows[0].records === 1 &&
  counts.rows[0].stored_responses === 1;
if (!ok) {
  console.error('idempotency verification failed');
  process.exit(1);
}
console.log('idempotency ok');
