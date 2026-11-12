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
  console.error('missing --database-url');
  process.exit(2);
}

const db = new Client({ connectionString: databaseUrl });
await db.connect();

const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
const jwk = publicKey.export({ format: 'jwk' });
const { rfc7638Thumbprint } = await import('@buyeros/core');
await db.query("INSERT INTO principal (id, email, display_name) VALUES ('prn_demo','priya@example.com','Priya') ON CONFLICT (id) DO NOTHING");
const thumbprint = rfc7638Thumbprint(jwk);
await db.query(
  `INSERT INTO agent (id, principal_id, display_name, key_thumbprint)
   VALUES ($1,'prn_demo','probe agent',$2)
   ON CONFLICT (key_thumbprint) DO NOTHING`,
  [`agt_${thumbprint.slice(4, 16)}`, thumbprint],
);

function headers(body, signature) {
  return {
    'content-type': 'application/json',
    'x-agent-jwk': JSON.stringify(jwk),
    'x-agent-signature': signature,
  };
}

async function checkout(requestKey, signature) {
  const body = { requestKey };
  const response = await fetch(new URL('/api/checkouts', base), {
    method: 'POST',
    headers: headers(body, signature(body)),
    body: JSON.stringify(body),
  });
  return { status: response.status, retryAfter: response.headers.get('retry-after') };
}

const sign = (payload) =>
  cryptoSign('sha256', Buffer.from(canonical(payload), 'utf8'), {
    key: privateKey,
    dsaEncoding: 'ieee-p1363',
  }).toString('base64url');

const stamp = Date.now();
const statuses = await Promise.all(
  Array.from({ length: 11 }, (_, index) =>
    checkout(`agent-rl-${stamp}-${index}`, sign),
  ),
);
console.log('agent statuses:', statuses.map((entry) => entry.status).join(','));
const limited = statuses.filter((entry) => entry.status === 429);
console.log('429 retry-after:', limited[0]?.retryAfter);

const bad = await fetch(new URL('/api/checkouts', base), {
  method: 'POST',
  headers: headers({ requestKey: 'bad-signature-0000001' }, 'AAAA'),
  body: JSON.stringify({ requestKey: 'bad-signature-0000001' }),
});
console.log('bad signature:', bad.status, JSON.stringify(await bad.json()));

const anonymous = await fetch(new URL('/api/checkouts', base), {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ requestKey: 'anonymous-000000001' }),
});
console.log('anonymous:', anonymous.status);

const foreignOrigin = await fetch(new URL('/api/checkouts', base), {
  method: 'POST',
  headers: { 'content-type': 'application/json', origin: 'https://evil.example' },
  body: JSON.stringify({ requestKey: 'foreign-origin-000001' }),
});
console.log('foreign origin:', foreignOrigin.status);

const unauthenticatedMandate = await fetch(new URL('/api/mandates/compile', base), {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ brief: 'a rug for $250' }),
});
console.log('compile without session:', unauthenticatedMandate.status);

const magic = await fetch(new URL('/api/auth/magic-link', base), {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ email: 'priya@example.com' }),
});
const magicBody = await magic.json();
console.log('magic-link:', magic.status, Boolean(magicBody.link));
const token = new URL(magicBody.link).searchParams.get('token');
const verify = await fetch(new URL(`/api/auth/verify?token=${encodeURIComponent(token)}`, base), {
  redirect: 'manual',
});
const setCookie = verify.headers.get('set-cookie') ?? '';
console.log('verify:', verify.status, setCookie.includes('buyeros_session='));

const authed = await fetch(new URL('/api/mandates/compile', base), {
  method: 'POST',
  headers: { 'content-type': 'application/json', cookie: setCookie.split(';')[0] },
  body: JSON.stringify({ brief: 'a rug for $250 from shop-a.example' }),
});
console.log('compile with session:', authed.status);

await db.end();
const ok =
  statuses.filter((entry) => entry.status === 200).length === 10 &&
  limited.length === 1 &&
  Number(limited[0]?.retryAfter) >= 1 &&
  bad.status === 403 &&
  anonymous.status === 401 &&
  foreignOrigin.status === 403 &&
  unauthenticatedMandate.status === 401 &&
  token &&
  setCookie.includes('buyeros_session=') &&
  authed.status === 200;
if (!ok) {
  console.error('auth/rate-limit verification failed');
  process.exit(1);
}
console.log('auth + rate limit ok');
