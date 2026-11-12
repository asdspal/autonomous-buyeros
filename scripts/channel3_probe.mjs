#!/usr/bin/env node
import { readFileSync, writeFileSync } from 'node:fs';
import { searchChannel3, toSnapshot } from '@buyeros/core';

const env = Object.fromEntries(
  readFileSync('.env', 'utf8')
    .split('\n')
    .filter((line) => line.includes('=') && !line.startsWith('#'))
    .map((line) => [line.slice(0, line.indexOf('=')), line.slice(line.indexOf('=') + 1)]),
);

const query = process.argv[2] ?? 'machine washable area rug';
const products = await searchChannel3(query, { apiKey: env.CHANNEL3_API_KEY });
if (!products.length) {
  console.error('no products returned');
  process.exit(1);
}
const snapshot = toSnapshot(products[0], {
  source: 'live',
  fetchedAt: new Date().toISOString(),
});
const evidence = {
  run: new Date().toISOString(),
  query,
  product_id: snapshot.productId,
  merchant: snapshot.merchant,
  price_minor: snapshot.priceMinor,
  currency: snapshot.currency,
  attributes: snapshot.attributes,
  present: {
    material: snapshot.attributes.material !== null,
    returnWindowDays: snapshot.attributes.returnWindowDays !== null,
    washable: snapshot.attributes.washable !== null,
  },
  record_hash: snapshot.recordHash,
  source_fields: {
    material: 'structured_attributes["rug-material"] || materials[0]',
    washable: 'structured_attributes["care-instructions"] || key_features',
    returnWindowDays: 'title/description regex "N-day return"',
  },
};
writeFileSync('probe/m1.5-live.json', JSON.stringify(evidence, null, 2) + '\n');
console.log(JSON.stringify(evidence, null, 2));
