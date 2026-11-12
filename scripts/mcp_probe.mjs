#!/usr/bin/env node
import { generateKeyPairSync, randomUUID, sign as cryptoSign } from 'node:crypto';
import { Client } from 'pg';
import { canonical, rfc7638Thumbprint } from '@buyeros/core';

const args = process.argv.slice(2);
const take = (name, fallback) => {
  const index = args.indexOf(name);
  return index === -1 ? fallback : args[index + 1];
};
const base = take('--url', process.env.DEMO_URL ?? 'http://localhost:3210');
const databaseUrl = take('--database-url', process.env.DATABASE_URL);
if (!databaseUrl) { console.error('missing --database-url'); process.exit(2); }

const db = new Client({ connectionString: databaseUrl });
await db.connect();

const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
const jwk = publicKey.export({ format: 'jwk' });
const thumbprint = rfc7638Thumbprint(jwk);
await db.query("INSERT INTO principal (id,email,display_name) VALUES ('prn_demo','priya@example.com','Priya') ON CONFLICT DO NOTHING");
await db.query(
  `INSERT INTO agent (id,principal_id,display_name,key_thumbprint)
   VALUES ($1,'prn_demo','mcp probe',$2) ON CONFLICT (key_thumbprint) DO NOTHING`,
  [`agt_${thumbprint.slice(4, 16)}`, thumbprint],
);
const agent = await db.query('SELECT id FROM agent WHERE key_thumbprint = $1', [thumbprint]);
const mandateId = `mdt_${randomUUID().replaceAll('-', '').slice(0, 16)}`;
const now = Math.floor(Date.now() / 1000);
await db.query(
  `INSERT INTO mandate (id,principal_id,agent_id,status,currency,purchase_total_minor,per_txn_minor,max_txns,
     constraints,nonce,iat_epoch,exp_epoch,signature)
   VALUES ($1,'prn_demo',$2,'ACTIVE','USD',25000,20000,1,'{}'::jsonb,$3,$4,$5,'sig')`,
  [mandateId, agent.rows[0].id, `n_${randomUUID().replaceAll('-', '')}`, now - 60, now + 3600],
);

function sign(body) {
  return cryptoSign('sha256', Buffer.from(canonical(body), 'utf8'), {
    key: privateKey,
    dsaEncoding: 'ieee-p1363',
  }).toString('base64url');
}

async function rpc(payload) {
  const response = await fetch(new URL('/mcp', base), {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-agent-jwk': JSON.stringify(jwk),
      'x-agent-signature': sign(payload),
    },
    body: JSON.stringify(payload),
  });
  return response.json();
}

const list = await rpc({ jsonrpc: '2.0', id: 1, method: 'tools/list' });
const names = (list.result?.tools ?? []).map((tool) => tool.name).sort();
console.log('tools:', names.join(','));
const forbidden = ['approve', 'capture', 'void', 'sign_offer', 'widen', 'revoke'];
const hasForbidden = names.some((name) => forbidden.some((word) => name.includes(word)));

const mandate = await rpc({
  jsonrpc: '2.0',
  id: 2,
  method: 'tools/call',
  params: { name: 'get_mandate', arguments: { mandate_id: mandateId } },
});
const mandatePayload = JSON.parse(mandate.result.content[0].text);
console.log('get_mandate:', mandate.result.isError, mandatePayload.mandate?.status);

const missing = await rpc({
  jsonrpc: '2.0',
  id: 3,
  method: 'tools/call',
  params: { name: 'get_verdict', arguments: { verdict_id: 'vrd_missing' } },
});
console.log('get_verdict missing:', missing.result.isError);

const anonymous = await fetch(new URL('/mcp', base), {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ jsonrpc: '2.0', id: 4, method: 'tools/list' }),
});
const anonBody = await anonymous.json();
console.log('anonymous:', anonymous.status, anonBody.error?.code);

await db.end();
const ok =
  names.length === 5 &&
  JSON.stringify(names) === JSON.stringify(['get_mandate', 'get_quote', 'get_verdict', 'request_checkout', 'spend_tool_credit']) &&
  !hasForbidden &&
  mandate.result.isError === false &&
  mandatePayload.mandate.status === 'ACTIVE' &&
  missing.result.isError === true &&
  anonymous.status === 200 &&
  anonBody.error?.code === -32001;
if (!ok) { console.error('mcp verification failed'); process.exit(1); }
console.log('mcp ok');
