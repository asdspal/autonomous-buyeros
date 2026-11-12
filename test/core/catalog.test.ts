import assert from 'node:assert/strict';
import { test } from 'node:test';
import { toSnapshot } from '../../packages/core/src/catalog/snapshot.js';
import { searchChannel3 } from '../../packages/core/src/catalog/channel3.js';
import type { Channel3Product } from '../../packages/core/src/catalog/channel3.js';

const product: Channel3Product = {
  id: 'ch3_rug_777',
  title: 'Washable Checkered Rug',
  description: 'A soft rug with a 30-day free return policy.',
  materials: ['Polyester'],
  key_features: ['Machine Washable', 'Pet friendly'],
  structured_attributes: {
    'rug-material': ['Microfiber'],
    'care-instructions': ['Machine washable'],
    'rug-shape': ['Rectangular'],
  },
  offers: [{ domain: 'shop-a.example', price: { price: 44.99, currency: 'USD' } }],
  category: { slug: 'rugs' },
};

test('price is normalised to integer minor units', () => {
  const snapshot = toSnapshot(product, { source: 'live', fetchedAt: '2026-11-12T00:00:00Z' });
  assert.equal(snapshot.priceMinor, 4499);
  assert.equal(snapshot.currency, 'USD');
  assert.equal(snapshot.merchant, 'shop-a.example');
});

test('the three demo predicates are extracted, missing ones stay null', () => {
  const snapshot = toSnapshot(product, { source: 'live', fetchedAt: '2026-11-12T00:00:00Z' });
  assert.deepEqual(snapshot.attributes, {
    material: 'microfiber',
    returnWindowDays: 30,
    washable: true,
  });
  const bare = toSnapshot(
    { id: 'ch3_rug_778', title: 'Rug', offers: [{ domain: 'x', price: { price: 10, currency: 'USD' } }] },
    { source: 'fixture', fetchedAt: '2026-11-12T00:00:00Z' },
  );
  assert.deepEqual(bare.attributes, { material: null, returnWindowDays: null, washable: null });
});

test('the record hash ignores fetchedAt but covers every field', () => {
  const a = toSnapshot(product, { source: 'live', fetchedAt: '2026-11-12T00:00:00Z' });
  const b = toSnapshot(product, { source: 'live', fetchedAt: '2026-11-13T00:00:00Z' });
  assert.equal(a.recordHash, b.recordHash);
  assert.match(a.recordHash, /^sha256:[0-9a-f]{64}$/);
  const changed = toSnapshot(
    { ...product, offers: [{ domain: 'shop-a.example', price: { price: 45.99, currency: 'USD' } }] },
    { source: 'live', fetchedAt: '2026-11-12T00:00:00Z' },
  );
  assert.notEqual(a.recordHash, changed.recordHash);
});

test('key order in the source record does not change the hash', () => {
  const reordered: Channel3Product = {
    offers: product.offers,
    category: product.category,
    materials: product.materials,
    key_features: product.key_features,
    structured_attributes: {
      'rug-shape': ['Rectangular'],
      'care-instructions': ['Machine washable'],
      'rug-material': ['Microfiber'],
    },
    description: product.description,
    title: product.title,
    id: product.id,
  };
  const a = toSnapshot(product, { source: 'live', fetchedAt: '2026-11-12T00:00:00Z' });
  const b = toSnapshot(reordered, { source: 'live', fetchedAt: '2026-11-12T00:00:00Z' });
  assert.equal(a.recordHash, b.recordHash);
});

test('the client retries a 429 once and then returns products', async () => {
  let calls = 0;
  const fetchImpl = (async () => {
    calls += 1;
    if (calls === 1) {
      return new Response('', { status: 429, headers: { 'retry-after': '1' } });
    }
    return new Response(JSON.stringify({ products: [product] }), { status: 200 });
  }) as typeof fetch;
  const products = await searchChannel3('rug', { apiKey: 'k', fetchImpl, maxRetries: 1 });
  assert.equal(products.length, 1);
  assert.equal(calls, 2);
});

test('the client surfaces a non-200 as a named error', async () => {
  const fetchImpl = (async () => new Response('', { status: 503 })) as typeof fetch;
  await assert.rejects(searchChannel3('rug', { apiKey: 'k', fetchImpl }), /CHANNEL3_503/);
});
