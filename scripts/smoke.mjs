#!/usr/bin/env node
const base = process.argv[2] ?? process.env.DEMO_URL;

if (!base) {
  console.error('usage: node scripts/smoke.mjs <base-url>');
  process.exit(2);
}

const url = new URL('/api/health', base);
const response = await fetch(url, { headers: { 'x-correlation-id': 'smoke-00000001' } });
const body = await response.json();
const correlation = response.headers.get('x-correlation-id');

const failures = [];
if (response.status !== 200) failures.push(`status ${response.status}`);
if (body.database !== 'up') failures.push(`database ${body.database}`);
if (correlation !== 'smoke-00000001') failures.push(`correlation ${correlation}`);

console.log(JSON.stringify({ url: url.href, status: response.status, body, correlation }, null, 2));
if (failures.length) {
  console.error('smoke failed:', failures.join(', '));
  process.exit(1);
}
console.log('smoke ok');
