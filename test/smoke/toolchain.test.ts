import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { canonical } from '../../packages/core/src/mandate/jcs.js';

function readPackage(): Record<string, unknown> {
  return JSON.parse(
    readFileSync(path.join(process.cwd(), 'package.json'), 'utf8'),
  ) as Record<string, unknown>;
}

test('package.json declares the ESM module type', () => {
  assert.equal(readPackage().type, 'module');
});

test('the Node engine range is the pinned one', () => {
  const engines = readPackage().engines as Record<string, unknown>;
  assert.equal(engines.node, '>=22 <27');
});

test('jose signs and verifies a canonicalised integer payload', async () => {
  const { SignJWT, jwtVerify, generateKeyPair } = await import('jose');
  const { privateKey, publicKey } = await generateKeyPair('ES256');
  const payload = { mandate_id: 'mdt_smoke0000001', total_minor: 25000 };
  assert.equal(canonical(payload), '{"mandate_id":"mdt_smoke0000001","total_minor":25000}');

  const token = await new SignJWT(payload)
    .setProtectedHeader({ alg: 'ES256' })
    .setIssuedAt()
    .sign(privateKey);
  const { payload: verified } = await jwtVerify(token, publicKey);
  assert.equal(verified.total_minor, 25000);

  const tampered = token.slice(0, -2) + (token.endsWith('A') ? 'BB' : 'AA');
  await assert.rejects(() => jwtVerify(tampered, publicKey));
});
