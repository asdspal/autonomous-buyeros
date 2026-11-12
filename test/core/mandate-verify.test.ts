import assert from 'node:assert/strict';
import { generateKeyPairSync, sign as cryptoSign } from 'node:crypto';
import { test } from 'node:test';
import { canonical } from '../../packages/core/src/mandate/jcs.js';
import { parseMandate } from '../../packages/core/src/mandate/schema.js';
import { verifyMandate } from '../../packages/core/src/mandate/verify.js';
import { rfc7638Thumbprint } from '../../packages/core/src/keys.js';
import type { PublicJwk } from '../../packages/core/src/keys.js';

export const validMandate = {
  vct: 'mandate.checkout.open.1' as const,
  mandate_id: 'mdt_verifysample01',
  issuer: 'principal:priya01',
  agent_cnf: 'jkt:agentdemo0001',
  nonce: 'n_verify_000000001',
  iat: 1_793_000_000,
  exp: 1_795_592_000,
  constraints: {
    budget: { currency: 'USD', total_minor: 25000, per_txn_minor: 20000, max_txns: 1 },
    metering: { currency: 'USD', total_minor: 300, per_call_minor: 20, max_calls: 40 },
    merchants: { mode: 'allowlist' as const, domain_hashes: ['shop-a.example'] },
    items: [
      {
        spec_id: 'rug',
        max_qty: 1,
        required_attrs: { machine_washable: { true: true } },
      },
    ],
    shipping: { deadline_days: 10 },
    unknown_attribute_policy: 'escalate' as const,
    refundability: { min: 'returnable' as const },
  },
};

function signer() {
  const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const jwk = publicKey.export({ format: 'jwk' }) as PublicJwk;
  return {
    jwk,
    sign: (payload: unknown) =>
      cryptoSign('sha256', Buffer.from(canonical(payload), 'utf8'), {
        key: privateKey,
        dsaEncoding: 'ieee-p1363',
      }).toString('base64url'),
  };
}

test('a valid mandate parses and verifies', async () => {
  const parsed = parseMandate(validMandate);
  assert.equal(parsed.ok, true);
  if (!parsed.ok) return;
  const { jwk, sign } = signer();
  const result = await verifyMandate(parsed.mandate, sign(validMandate), jwk, 1_793_500_000);
  assert.equal(result.ok, true);
  assert.equal(result.thumbprint, rfc7638Thumbprint(jwk));
});

test('any changed signed byte fails verification with MV-R015', async () => {
  const parsed = parseMandate(validMandate);
  assert.ok(parsed.ok);
  const { jwk, sign } = signer();
  const signature = sign(validMandate);
  const tampered = structuredClone(validMandate);
  tampered.constraints.budget.total_minor = 25001;
  const parsedTampered = parseMandate(tampered);
  assert.ok(parsedTampered.ok);
  const result = await verifyMandate(parsedTampered.mandate, signature, jwk, 1_793_500_000);
  assert.deepEqual(result, { ok: false, code: 'MV-R015', thumbprint: rfc7638Thumbprint(jwk) });
});

test('an expired mandate is refused with MV-R006 even with a good signature', async () => {
  const parsed = parseMandate(validMandate);
  assert.ok(parsed.ok);
  const { jwk, sign } = signer();
  const result = await verifyMandate(
    parsed.mandate,
    sign(validMandate),
    jwk,
    validMandate.exp + 1,
  );
  assert.equal(result.ok, false);
  assert.equal(result.code, 'MV-R006');
});

test('a different key fails verification', async () => {
  const parsed = parseMandate(validMandate);
  assert.ok(parsed.ok);
  const { sign } = signer();
  const other = signer();
  const result = await verifyMandate(parsed.mandate, sign(validMandate), other.jwk, 1_793_500_000);
  assert.equal(result.ok, false);
  assert.equal(result.code, 'MV-R015');
});

test('a private JWK is rejected before verification', async () => {
  const parsed = parseMandate(validMandate);
  assert.ok(parsed.ok);
  const { jwk, sign } = signer();
  const withPrivate = { ...jwk, d: 'secret' };
  const result = await verifyMandate(parsed.mandate, sign(validMandate), withPrivate, 1_793_500_000);
  assert.equal(result.ok, false);
  assert.equal(result.code, 'MV-R015');
});

test('the schema refuses every dangerous widening', () => {
  const cases: Array<[string, (value: typeof validMandate) => void]> = [
    ['budget above the schema ceiling', (v) => (v.constraints.budget.total_minor = 5_000_001)],
    ['per-txn above total', (v) => (v.constraints.budget.per_txn_minor = 30_000)],
    ['too many transactions', (v) => (v.constraints.budget.max_txns = 21)],
    ['too many item lines', (v) => (v.constraints.items = Array(6).fill(v.constraints.items[0]))],
    ['meter cap above ceiling', (v) => (v.constraints.metering.total_minor = 50_001)],
    ['lifetime above 30 days', (v) => (v.exp = v.iat + 2_592_001)],
    ['zero budget', (v) => (v.constraints.budget.total_minor = 0)],
    ['lowercase currency', (v) => (v.constraints.budget.currency = 'usd')],
  ];
  for (const [name, mutate] of cases) {
    const value = structuredClone(validMandate);
    mutate(value);
    if (name === 'lowercase currency') {
      (value.constraints.budget as { currency: string }).currency = 'usd';
    }
    const result = parseMandate(value);
    assert.equal(result.ok, false, `${name} should be refused`);
  }
});

test('the thumbprint is RFC 7638 stable across key order', () => {
  const { jwk } = signer();
  const reordered = { y: jwk.y, x: jwk.x, crv: jwk.crv, kty: jwk.kty };
  assert.equal(rfc7638Thumbprint(jwk), rfc7638Thumbprint(reordered));
  assert.match(rfc7638Thumbprint(jwk), /^jkt:[A-Za-z0-9_-]{43}$/);
});
