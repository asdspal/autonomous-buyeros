import assert from 'node:assert/strict';
import { test } from 'node:test';
import { canonical, sha256Hex } from '../../packages/core/src/mandate/jcs.js';
import { digest } from '../../packages/core/src/mandate/hash.js';

test('key order does not change the canonical bytes', () => {
  const a = { b: 2, a: 1 };
  const b = { a: 1, b: 2 };
  assert.equal(canonical(a), '{"a":1,"b":2}');
  assert.equal(canonical(a), canonical(b));
  assert.equal(sha256Hex(canonical(a)), sha256Hex(canonical(b)));
});

test('the exact bytes for a two-key object are stable', () => {
  assert.equal(canonical({ total_minor: 25000, currency: 'USD' }), '{"currency":"USD","total_minor":25000}');
});

test('nested objects sort at every level and arrays keep their order', () => {
  const value = { z: [{ b: 1, a: 2 }], a: { d: 4, c: 3 } };
  assert.equal(canonical(value), '{"a":{"c":3,"d":4},"z":[{"a":2,"b":1}]}');
});

test('floats are rejected rather than rounded', () => {
  assert.throws(() => canonical({ amount: 1.5 }), /floats are not canonicalised/);
});

test('non-plain values are rejected, so a clause cannot silently sign empty', () => {
  assert.throws(() => canonical(new Map([['a', 1]])), /unsupported type/);
  assert.throws(() => canonical(undefined), /unsupported type/);
});

test('digest is stable and namespaced', () => {
  const value = { a: 1, b: [true, null, 'x'] };
  assert.match(digest(value), /^sha256:[0-9a-f]{64}$/);
  assert.equal(digest(value), digest({ b: [true, null, 'x'], a: 1 }));
});
