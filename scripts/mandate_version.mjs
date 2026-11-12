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
if (!databaseUrl) {
  console.error('missing --database-url or DATABASE_URL');
  process.exit(2);
}

const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
const jwk = publicKey.export({ format: 'jwk' });

function mandate() {
  return {
    vct: 'mandate.checkout.open.1',
    mandate_id: `mdt_${randomUUID().replaceAll('-', '').slice(0, 16)}`,
    issuer: 'principal:priya01',
    agent_cnf: 'jkt:agentdemo0001',
    nonce: `n_${randomUUID().replaceAll('-', '')}`,
    iat: Math.floor(Date.now() / 1000) - 60,
    exp: Math.floor(Date.now() / 1000) + 86_400,
    constraints: {
      budget: { currency: 'USD', total_minor: 25000, per_txn_minor: 20000, max_txns: 1 },
      metering: { currency: 'USD', total_minor: 300, per_call_minor: 20, max_calls: 40 },
      merchants: { mode: 'allowlist', domain_hashes: ['shop-a.example'] },
      items: [{ spec_id: 'rug', max_qty: 1, required_attrs: { machine_washable: { true: true } } }],
      shipping: { deadline_days: 14 },
      unknown_attribute_policy: 'escalate',
      refundability: { min: 'returnable' },
    },
  };
}

async function post(path, body) {
  const response = await fetch(new URL(path, base), {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(process.env.SERVICE_TOKEN ? { 'x-service-token': process.env.SERVICE_TOKEN } : {}) },
    body: JSON.stringify(body),
  });
  return { status: response.status, body: await response.json() };
}

function signed(payload) {
  return cryptoSign('sha256', Buffer.from(canonical(payload), 'utf8'), {
    key: privateKey,
    dsaEncoding: 'ieee-p1363',
  }).toString('base64url');
}

const v1 = mandate();
const first = await post('/api/mandates', { mandate: v1, signature: signed(v1), publicJwk: jwk });
console.log('v1:', first.status, JSON.stringify(first.body));

const v2 = mandate();
v2.constraints.budget.total_minor = 30000;
const second = await post('/api/mandates', {
  mandate: v2,
  signature: signed(v2),
  publicJwk: jwk,
  previousMandateId: v1.mandate_id,
});
console.log('v2:', second.status, JSON.stringify(second.body));

const revoked = await post(`/api/mandates/${v2.mandate_id}/revoke`, {});
console.log('revoke:', revoked.status, JSON.stringify(revoked.body));
const again = await post(`/api/mandates/${v2.mandate_id}/revoke`, {});
console.log('revoke again:', again.status, JSON.stringify(again.body));

const db = new Client({ connectionString: databaseUrl });
await db.connect();
const rows = await db.query(
  `SELECT id, version, prev_version_id, status,
          (SELECT count(*) FROM mandate_clause mc WHERE mc.mandate_id = m.id) AS clauses
     FROM mandate m WHERE id = ANY($1::text[]) ORDER BY version`,
  [[v1.mandate_id, v2.mandate_id]],
);
const audit = await db.query(
  'SELECT action, subject_id FROM audit_event WHERE subject_id = $1',
  [v2.mandate_id],
);
await db.end();
console.log('rows:', JSON.stringify(rows.rows));
console.log('audit:', JSON.stringify(audit.rows));

const ok =
  first.status === 201 &&
  first.body.version === 1 &&
  second.status === 201 &&
  second.body.version === 2 &&
  revoked.status === 200 &&
  again.status === 409 &&
  rows.rows.length === 2 &&
  rows.rows[0].status === 'REVOKED' &&
  rows.rows[1].version === 2 &&
  audit.rows.some((row) => row.action === 'mandate.revoked');
if (!ok) {
  console.error('version/revoke verification failed');
  process.exit(1);
}
console.log('version + revoke ok');
