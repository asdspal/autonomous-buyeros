#!/usr/bin/env node
import { randomUUID } from 'node:crypto';
import { Client } from 'pg';

const args = process.argv.slice(2);
const take = (name, fallback) => {
  const index = args.indexOf(name);
  return index === -1 ? fallback : args[index + 1];
};
const base = take('--url', process.env.DEMO_URL ?? 'http://localhost:3210');
const databaseUrl = take('--database-url', process.env.DATABASE_URL);
const serviceToken = process.env.SERVICE_TOKEN;
const paypalBase = process.env.PAYPAL_API_BASE ?? 'https://api-m.sandbox.paypal.com';
if (!databaseUrl || !serviceToken) { console.error('missing env'); process.exit(2); }

const db = new Client({ connectionString: databaseUrl });
await db.connect();
const basic = Buffer.from(`${process.env.PAYPAL_CLIENT_ID}:${process.env.PAYPAL_CLIENT_SECRET}`).toString('base64');
const token = (await (await fetch(`${paypalBase}/v1/oauth2/token`, {
  method: 'POST',
  headers: { authorization: `Basic ${basic}`, 'content-type': 'application/x-www-form-urlencoded' },
  body: 'grant_type=client_credentials',
})).json()).access_token;

const order = await (await fetch(`${paypalBase}/v2/checkout/orders`, {
  method: 'POST',
  headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', 'PayPal-Request-Id': randomUUID() },
  body: JSON.stringify({
    intent: 'AUTHORIZE',
    purchase_units: [{ reference_id: 'rcn', amount: { currency_code: 'USD', value: '9.00' } }],
    payment_source: { paypal: { vault_id: process.env.PAYPAL_VAULT_ID } },
  }),
})).json();
const authorizationId = order.purchase_units?.[0]?.payments?.authorizations?.[0]?.id;
if (!authorizationId) throw new Error('no authorization');

await db.query("INSERT INTO principal (id,email,display_name) VALUES ('prn_demo','priya@example.com','Priya') ON CONFLICT DO NOTHING");
await db.query(
  `INSERT INTO agent (id,principal_id,display_name,key_thumbprint) VALUES ($1,'prn_demo','rcn',$2)
   ON CONFLICT (key_thumbprint) DO NOTHING`,
  [`agt_${randomUUID().slice(0, 12)}`, 'jkt:agentdemo0001'],
);
const agent = await db.query("SELECT id FROM agent WHERE key_thumbprint = 'jkt:agentdemo0001'");
const mandateId = `mdt_${randomUUID().replaceAll('-', '').slice(0, 16)}`;
const now = Math.floor(Date.now() / 1000);
await db.query(
  `INSERT INTO mandate (id,principal_id,agent_id,status,currency,purchase_total_minor,per_txn_minor,max_txns,
     constraints,nonce,iat_epoch,exp_epoch,signature)
   VALUES ($1,'prn_demo',$2,'ACTIVE','USD',25000,20000,1,'{}'::jsonb,$3,$4,$5,'sig')`,
  [mandateId, agent.rows[0].id, `n_${randomUUID().replaceAll('-', '')}`, now - 60, now + 3600],
);
const checkoutId = `ckt_${randomUUID()}`;
await db.query(
  `INSERT INTO checkout (id,principal_id,mandate_id,merchant_domain,request_key,cart_hash,total_minor,currency,status,correlation_id)
   VALUES ($1,'prn_demo',$2,'shop-a.example',$3,$4,900,'USD','AUTHORIZED',$5)`,
  [checkoutId, mandateId, randomUUID().replaceAll('-', ''), `sha256:${'c'.repeat(64)}`, randomUUID()],
);
await db.query(
  `INSERT INTO paypal_authorization (id,purpose,checkout_id,order_id,authorization_id,amount_minor,currency,status,idempotency_key,created_at)
   VALUES ($1,'PURCHASE',$2,$3,$4,900,'USD','AUTHORIZED',$5, now() - interval '49 hours')`,
  [`aut_${randomUUID()}`, checkoutId, order.id, authorizationId, randomUUID()],
);

const response = await fetch(new URL('/api/jobs/reconcile-holds', base), {
  method: 'POST',
  headers: { 'content-type': 'application/json', 'x-service-token': serviceToken },
  body: '{}',
});
const result = await response.json();
console.log('job:', response.status, JSON.stringify(result).slice(0, 300));
const rows = await db.query(
  `SELECT status FROM paypal_authorization WHERE authorization_id = $1`,
  [authorizationId],
);
const audit = await db.query(
  "SELECT action FROM audit_event WHERE subject_id = $1",
  [authorizationId],
);
console.log('db:', rows.rows[0], 'audit:', audit.rows);
await db.end();
const ok =
  response.status === 200 &&
  Array.isArray(result.voided) &&
  result.voided.includes(authorizationId) &&
  rows.rows[0]?.status === 'VOIDED' &&
  audit.rows.some((row) => row.action === 'authorization.reconciled_void');
if (!ok) { console.error('reconcile verification failed'); process.exit(1); }
console.log('reconcile ok');
