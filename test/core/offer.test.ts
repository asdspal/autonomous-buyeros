import assert from 'node:assert/strict';
import { generateKeyPairSync, sign as cryptoSign } from 'node:crypto';
import type { KeyObject } from 'node:crypto';
import { test } from 'node:test';
import {
  auditAgainstOffer,
  checkPolicy,
  counterOffer,
  offerClauses,
  thumbprint,
  validateOffer,
  quoteTotalMinor,
} from '../../packages/core/src/offer.js';
import type { MerchantPolicy, OfferDocument, PublicJwk, Quote } from '../../packages/core/src/offer.js';

const policy: MerchantPolicy = {
  sku: 'rug_001',
  list_price_minor: 24900,
  floor_price_minor: 19900,
  max_discount_bp: 1200,
  min_qty: 1,
  max_qty: 5,
  allow_free_shipping: true,
  max_rounds: 6,
  policy_version: 'p1',
};

function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function signOffer(doc: OfferDocument, privateKey: KeyObject): string {
  const header = Buffer.from(JSON.stringify({ alg: 'ES256', typ: 'JWT' })).toString('base64url');
  const payload = Buffer.from(JSON.stringify(doc)).toString('base64url');
  const signature = cryptoSign(
    'sha256',
    Buffer.from(`${header}.${payload}`, 'utf8'),
    { key: privateKey, dsaEncoding: 'ieee-p1363' },
  ).toString('base64url');
  return `${header}.${payload}.${signature}`;
}

test('policy invariants refuse an impossible floor', () => {
  assert.throws(() => checkPolicy({ ...policy, floor_price_minor: 30000 }), /FLOOR_ABOVE_LIST/);
  assert.doesNotThrow(() => checkPolicy(policy));
});

test('5,000 random asks: every offer usable, none below the floor or over-granted', () => {
  const random = rng(42);
  let usable = 0;
  const breaches: string[] = [];
  for (let i = 0; i < 5000; i += 1) {
    const ask = Math.floor(random() * 10001);
    const qty = 1 + Math.floor(random() * 5);
    const quote = counterOffer(policy, qty, ask, random() < 0.5, 1 + Math.floor(random() * 6));
    const valid = validateOffer(policy, quote);
    if (valid.ok) usable += 1;
    else breaches.push(valid.code);
    const discountBp = Math.floor(
      ((policy.list_price_minor - quote.unit_price_minor) * 10000) / policy.list_price_minor,
    );
    if (quote.unit_price_minor < policy.floor_price_minor) breaches.push('BELOW_FLOOR');
    if (discountBp > policy.max_discount_bp) breaches.push('OVER_GRANT');
  }
  assert.equal(usable, 5000);
  assert.deepEqual(breaches, []);
});

test('adversarial asks are clamped or refused', () => {
  const huge = counterOffer(policy, 1, 9000, true, 1);
  assert.equal(huge.unit_price_minor, 21912);
  assert.equal(huge.free_shipping, false, 'free shipping needs qty >= 2');

  const negative = counterOffer(policy, 1, -5000, false, 1);
  assert.equal(negative.unit_price_minor, 24900);

  assert.throws(() => counterOffer(policy, 10000, 1000, false, 1), /QTY_OUT_OF_POLICY/);
  assert.throws(() => counterOffer(policy, 1, 1000, false, 7), /MAX_ROUNDS_EXCEEDED/);

  const forged: Quote = {
    sku: 'rug_001',
    qty: 1,
    unit_price_minor: 1,
    free_shipping: false,
    round_no: 1,
    policy_version: 'p1',
  };
  assert.deepEqual(validateOffer(policy, forged), { ok: false, code: 'BELOW_FLOOR' });
  assert.deepEqual(validateOffer(policy, { ...forged, unit_price_minor: 20000, policy_version: 'p0' }), {
    ok: false,
    code: 'POLICY_VERSION_STALE',
  });
});

test('a checkout must honour the signed offer total', () => {
  const quote = counterOffer(policy, 2, 1200, true, 3);
  const total = quoteTotalMinor(quote);
  assert.equal(total, 43824);
  assert.equal(quote.free_shipping, true);
  assert.equal(auditAgainstOffer(total, total), 'PASS');
  assert.equal(auditAgainstOffer(total, total + 1), 'MV-R021');
  assert.equal(auditAgainstOffer(total, policy.list_price_minor * 2), 'MV-R021');
});

test('signed offer verifies and is bound to its total', () => {
  const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const jwk = publicKey.export({ format: 'jwk' }) as PublicJwk;
  const doc: OfferDocument = {
    vct: 'offer.merchant.bound.1',
    offer_id: 'off_9c1d2e3f4a5b',
    merchant_domain: 'shop-a.example',
    merchant_key_thumbprint: thumbprint(jwk),
    policy_version: 'p1',
    sku: 'rug_001',
    qty: 2,
    unit_price_minor: 21912,
    shipping_minor: 0,
    free_shipping: true,
    currency: 'USD',
    cart_hash: 'sha256:abc',
    nonce: 'n_7c1f',
    iat: 1_762_828_800,
    exp: 1_762_830_600,
  };
  const token = signOffer(doc, privateKey);
  const now = 1_762_829_000;

  const ok = offerClauses({ offer: doc, jwk, token, sealedTotalMinor: 43824, nowEpoch: now });
  assert.deepEqual(ok.map((c) => c.result), ['PASS', 'PASS', 'PASS', 'PASS']);

  const wrongTotal = offerClauses({ offer: doc, jwk, token, sealedTotalMinor: 43825, nowEpoch: now });
  assert.ok(wrongTotal.some((c) => c.result === 'FAIL' && c.code === 'MV-R020'));

  const stale = offerClauses({ offer: doc, jwk, token, sealedTotalMinor: 43824, nowEpoch: doc.exp + 1 });
  assert.ok(stale.some((c) => c.result === 'FAIL' && c.code === 'MV-R019'));

  const otherKey = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const foreign = otherKey.publicKey.export({ format: 'jwk' }) as PublicJwk;
  const unknown = offerClauses({ offer: doc, jwk: foreign, token, sealedTotalMinor: 43824, nowEpoch: now });
  assert.ok(unknown.some((c) => c.result === 'FAIL' && c.code === 'MV-R018'));

  const tampered = (() => {
    const [h, , s] = token.split('.');
    const payload = Buffer.from(JSON.stringify({ ...doc, unit_price_minor: 1 })).toString('base64url');
    return `${h}.${payload}.${s}`;
  })();
  const bad = offerClauses({ offer: doc, jwk, token: tampered, sealedTotalMinor: 43824, nowEpoch: now });
  assert.ok(bad.some((c) => c.result === 'FAIL' && c.code === 'MV-R018'));
});
