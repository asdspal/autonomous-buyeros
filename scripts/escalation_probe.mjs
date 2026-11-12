#!/usr/bin/env node
import { generateKeyPairSync, randomUUID, sign as cryptoSign } from 'node:crypto';
import { Client } from 'pg';
import { canonical } from '@buyeros/core';

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

const paypalToken = await (async () => {
  const basic = Buffer.from(`${process.env.PAYPAL_CLIENT_ID}:${process.env.PAYPAL_CLIENT_SECRET}`).toString('base64');
  const response = await fetch(`${paypalBase}/v1/oauth2/token`, {
    method: 'POST',
    headers: { authorization: `Basic ${basic}`, 'content-type': 'application/x-www-form-urlencoded' },
    body: 'grant_type=client_credentials',
  });
  return (await response.json()).access_token;
})();

async function createVaultedAuth(amountMinor) {
  const response = await fetch(`${paypalBase}/v2/checkout/orders`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${paypalToken}`,
      'content-type': 'application/json',
      'PayPal-Request-Id': randomUUID(),
    },
    body: JSON.stringify({
      intent: 'AUTHORIZE',
      purchase_units: [{ reference_id: 'esc-probe', amount: { currency_code: 'USD', value: (amountMinor / 100).toFixed(2) } }],
      payment_source: { paypal: { vault_id: process.env.PAYPAL_VAULT_ID } },
    }),
  });
  const order = await response.json();
  const auth = order.purchase_units?.[0]?.payments?.authorizations?.[0];
  if (!auth) throw new Error(`no authorization: ${JSON.stringify(order).slice(0, 200)}`);
  return { orderId: order.id, authorizationId: auth.id };
}

async function setupEscalation(amountMinor) {
  await db.query("INSERT INTO principal (id,email,display_name) VALUES ('prn_demo','priya@example.com','Priya') ON CONFLICT DO NOTHING");
  const agentThumb = 'jkt:agentdemo0001';
  await db.query(
    `INSERT INTO agent (id,principal_id,display_name,key_thumbprint) VALUES ($1,'prn_demo','agent',$2)
     ON CONFLICT (key_thumbprint) DO NOTHING`,
    [`agt_${randomUUID().slice(0, 12)}`, agentThumb],
  );
  const agent = await db.query('SELECT id FROM agent WHERE key_thumbprint = $1', [agentThumb]);
  const mandateId = `mdt_${randomUUID().replaceAll('-', '').slice(0, 16)}`;
  const now = Math.floor(Date.now() / 1000);
  await db.query(
    `INSERT INTO mandate (id,principal_id,agent_id,status,currency,purchase_total_minor,per_txn_minor,max_txns,
       constraints,nonce,iat_epoch,exp_epoch,signature)
     VALUES ($1,'prn_demo',$2,'ACTIVE','USD',50000,50000,1,'{}'::jsonb,$3,$4,$5,'sig')`,
    [mandateId, agent.rows[0].id, `n_${randomUUID().replaceAll('-', '')}`, now - 60, now + 3600],
  );
  const checkoutId = `ckt_${randomUUID()}`;
  await db.query(
    `INSERT INTO checkout (id,principal_id,mandate_id,merchant_domain,request_key,cart_hash,total_minor,currency,status,correlation_id)
     VALUES ($1,'prn_demo',$2,'shop-a.example',$3,$4,$5,'USD','AUTHORIZED',$6)`,
    [checkoutId, mandateId, randomUUID().replaceAll('-', ''), `sha256:${'a'.repeat(64)}`, amountMinor, randomUUID()],
  );
  const auth = await createVaultedAuth(amountMinor);
  await db.query(
    `INSERT INTO paypal_authorization (id,purpose,checkout_id,order_id,authorization_id,amount_minor,currency,status,idempotency_key)
     VALUES ($1,'PURCHASE',$2,$3,$4,$5,'USD','AUTHORIZED',$6)`,
    [`aut_${randomUUID()}`, checkoutId, auth.orderId, auth.authorizationId, amountMinor, randomUUID()],
  );
  const verdictId = `vrd_${randomUUID()}`;
  await db.query(
    `INSERT INTO verdict (id,checkout_id,decision,reason_codes,evidence_hash,mandate_version,auditor_version,latency_us,correlation_id)
     VALUES ($1,$2,'ESCALATE','["MV-R005"]'::jsonb,$3,1,'probe',1000,$4)`,
    [verdictId, checkoutId, 'b'.repeat(64), randomUUID()],
  );
  return { checkoutId, verdictId, mandateId, authorizationId: auth.authorizationId };
}

async function post(path, body) {
  const response = await fetch(new URL(path, base), {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-service-token': serviceToken },
    body: JSON.stringify(body),
  });
  return { status: response.status, body: await response.json() };
}

const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
const jwk = publicKey.export({ format: 'jwk' });
const key = await post('/api/keys', { jwk });
if (key.status !== 201) { console.error('key registration failed', key); process.exit(1); }
const signApproval = (payload) => cryptoSign('sha256', Buffer.from(canonical(payload), 'utf8'), { key: privateKey, dsaEncoding: 'ieee-p1363' }).toString('base64url');

async function resolve(setup, action) {
  const payload = { verdictId: setup.verdictId, decision: action === 'approve' ? 'CAPTURE' : 'VOID', decidedAtEpoch: Math.floor(Date.now() / 1000), nonce: `n_${randomUUID().replaceAll('-', '')}` };
  return post(`/api/verdicts/${setup.verdictId}/escalation`, { action, signature: signApproval(payload), publicJwk: jwk, nonce: payload.nonce, decidedAtEpoch: payload.decidedAtEpoch });
}

const declineSetup = await setupEscalation(1000);
const declined = await resolve(declineSetup, 'decline');
console.log('decline:', declined.status, JSON.stringify(declined.body));

const approveSetup = await setupEscalation(1200);
const approved = await resolve(approveSetup, 'approve');
console.log('approve:', approved.status, JSON.stringify(approved.body));

const rows = await db.query(
  `SELECT a.authorization_id, a.status, a.captured_minor, e.status AS escalation, c.status AS checkout
     FROM paypal_authorization a JOIN checkout c ON c.id = a.checkout_id
     LEFT JOIN escalation e ON e.verdict_id = (SELECT id FROM verdict v WHERE v.checkout_id = c.id)
    WHERE a.authorization_id = ANY($1::text[])`,
  [[declineSetup.authorizationId, approveSetup.authorizationId]],
);
console.log('db:', JSON.stringify(rows.rows));
await db.end();
const byAuth = Object.fromEntries(rows.rows.map((r) => [r.authorization_id, r]));
const ok =
  declined.status === 200 && approved.status === 200 &&
  byAuth[declineSetup.authorizationId]?.status === 'VOIDED' &&
  byAuth[approveSetup.authorizationId]?.status === 'CAPTURED' &&
  Number(byAuth[approveSetup.authorizationId]?.captured_minor) === 1200 &&
  byAuth[declineSetup.authorizationId]?.escalation === 'DECLINED' &&
  byAuth[approveSetup.authorizationId]?.escalation === 'APPROVED';
if (!ok) { console.error('escalation verification failed'); process.exit(1); }
console.log('escalation ok');
