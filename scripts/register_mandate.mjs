#!/usr/bin/env node
import { generateKeyPairSync, randomUUID, sign as cryptoSign } from 'node:crypto';
import { canonical } from '@buyeros/core';

const args = process.argv.slice(2);
const urlIndex = args.indexOf('--url');
const base = urlIndex === -1 ? process.env.DEMO_URL ?? 'http://localhost:3210' : args[urlIndex + 1];

const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
const jwk = publicKey.export({ format: 'jwk' });
const nonce = `n_${randomUUID().replaceAll('-', '')}`;
const mandate = {
  vct: 'mandate.checkout.open.1',
  mandate_id: `mdt_${randomUUID().replaceAll('-', '').slice(0, 16)}`,
  issuer: 'principal:priya01',
  agent_cnf: 'jkt:agentdemo0001',
  nonce,
  iat: Math.floor(Date.now() / 1000) - 60,
  exp: Math.floor(Date.now() / 1000) + 86_400,
  constraints: {
    budget: { currency: 'USD', total_minor: 25000, per_txn_minor: 20000, max_txns: 1 },
    metering: { currency: 'USD', total_minor: 300, per_call_minor: 20, max_calls: 40 },
    merchants: { mode: 'allowlist', domain_hashes: ['shop-a.example'] },
    items: [
      {
        spec_id: 'rug',
        max_qty: 1,
        required_attrs: { machine_washable: { true: true } },
      },
    ],
    shipping: { deadline_days: 10 },
    unknown_attribute_policy: 'escalate',
    refundability: { min: 'returnable' },
  },
};
const signature = cryptoSign('sha256', Buffer.from(canonical(mandate), 'utf8'), {
  key: privateKey,
  dsaEncoding: 'ieee-p1363',
}).toString('base64url');

async function post(path, body) {
  const response = await fetch(new URL(path, base), {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-correlation-id': `m12-${randomUUID()}` },
    body: JSON.stringify(body),
  });
  const text = await response.text();
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    parsed = text;
  }
  return { status: response.status, body: parsed };
}

const first = await post('/api/mandates', { mandate, signature, publicJwk: jwk });
console.log('register:', first.status, JSON.stringify(first.body));
const replay = await post('/api/mandates', { mandate, signature, publicJwk: jwk });
console.log('replay  :', replay.status, JSON.stringify(replay.body));

const tampered = structuredClone(mandate);
tampered.constraints.budget.total_minor = 99999;
const bad = await post('/api/mandates', { mandate: tampered, signature, publicJwk: jwk });
console.log('tampered:', bad.status, JSON.stringify(bad.body));

if (first.status !== 201) process.exit(1);
if (replay.status !== 409 || replay.body?.error?.code !== 'MV-R007') process.exit(1);
if (bad.status !== 422 || bad.body?.error?.code !== 'MV-R015') process.exit(1);
console.log('mandate registration ok');
