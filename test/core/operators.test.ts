import assert from 'node:assert/strict';
import { test } from 'node:test';
import { evaluateOperator, OPERATORS } from '../../packages/core/src/auditor/operators.js';
import { resolveAttribute, ATTRIBUTE_SOURCES } from '../../packages/core/src/auditor/attributes.js';
import { R } from '../../packages/core/src/reason-codes.js';
import type { Cart, Catalog } from '../../packages/core/src/types.js';

const cart: Cart = {
  product_id: 'ch3_rug_001',
  merchant_domain: 'shop-a.example',
  unit_price_minor: 18900,
  qty: 1,
  currency: 'USD',
  attrs_claimed: { machine_washable: true, material: 'cotton' },
};

const catalog: Catalog = {
  product_id: 'ch3_rug_001',
  attrs: { machine_washable: true, material: 'wool', return_window_days: 30 },
};

test('operators are exhaustive over a closed set', () => {
  assert.deepEqual([...OPERATORS].sort(), ['eq', 'gte', 'in', 'lte', 'matches', 'oneOf', 'true']);
  assert.throws(() => evaluateOperator('lt', 1, 2), /unknown operator/);
});

test('integers: gte/lte boundaries are inclusive and typed', () => {
  assert.equal(evaluateOperator('gte', 30, 30), 'PASS');
  assert.equal(evaluateOperator('gte', 29, 30), 'FAIL');
  assert.equal(evaluateOperator('lte', 10, 10), 'PASS');
  assert.equal(evaluateOperator('lte', 11, 10), 'FAIL');
  assert.equal(evaluateOperator('gte', '30', 30), 'UNKNOWN', 'no string-to-number coercion');
});

test('strings and booleans are compared without coercion', () => {
  assert.equal(evaluateOperator('eq', 'cotton', 'cotton'), 'PASS');
  assert.equal(evaluateOperator('eq', 'cotton', 'wool'), 'FAIL');
  assert.equal(evaluateOperator('eq', true, 1), 'FAIL');
  assert.equal(evaluateOperator('true', true, true), 'PASS');
  assert.equal(evaluateOperator('true', 'yes', true), 'FAIL');
});

test('in and oneOf are set membership, and an empty list never passes', () => {
  assert.equal(evaluateOperator('in', 'cotton', ['cotton', 'wool']), 'PASS');
  assert.equal(evaluateOperator('oneOf', 'silk', ['cotton', 'wool']), 'FAIL');
  assert.equal(evaluateOperator('in', 'cotton', []), 'FAIL');
  assert.equal(evaluateOperator('in', 'cotton', 'cotton'), 'FAIL');
});

test('matches handles ISO date shapes and refuses a bad pattern', () => {
  assert.equal(evaluateOperator('matches', '2026-11-12', '^\\d{4}-\\d{2}-\\d{2}$'), 'PASS');
  assert.equal(evaluateOperator('matches', '12/11/2026', '^\\d{4}-\\d{2}-\\d{2}$'), 'FAIL');
  assert.equal(evaluateOperator('matches', '2026-11-12', '['), 'UNKNOWN');
});

test('null and undefined are UNKNOWN at every operator', () => {
  for (const op of OPERATORS) {
    assert.equal(evaluateOperator(op, null, 1), 'UNKNOWN', `${op} null`);
    assert.equal(evaluateOperator(op, undefined, 1), 'UNKNOWN', `${op} undefined`);
  }
});

test('catalogue is ground truth; a merchant claim is never evidence', () => {
  assert.deepEqual(resolveAttribute(cart, catalog, 'material'), {
    observed: 'wool',
    source: 'catalog',
  });
  assert.deepEqual(resolveAttribute(cart, catalog, 'machine_washable'), {
    observed: true,
    source: 'catalog',
  });
  const noCatalog: Catalog = { product_id: 'ch3_rug_001', attrs: {} };
  assert.deepEqual(resolveAttribute(cart, noCatalog, 'material'), {
    observed: null,
    source: 'merchant_claim_untrusted',
  });
  assert.deepEqual(resolveAttribute(cart, noCatalog, 'washable'), {
    observed: null,
    source: 'absent',
  });
});

test('the reason-code set is closed and every code is MV-Rnnn', () => {
  const codes = Object.values(R);
  assert.equal(codes.length, 26);
  assert.equal(new Set(codes).size, 26);
  for (const code of codes) assert.match(code, /^MV-R\d{3}$/);
});

test('auditor sources stay inside the stored vocabulary', () => {
  assert.ok(ATTRIBUTE_SOURCES.includes('catalog'));
  assert.ok(ATTRIBUTE_SOURCES.includes('merchant_claim_untrusted'));
  assert.ok(ATTRIBUTE_SOURCES.includes('absent'));
});
