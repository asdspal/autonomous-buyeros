import assert from 'node:assert/strict';
import { test } from 'node:test';
import { seal } from '../../packages/core/src/cart/seal.js';
import type { Cart } from '../../packages/core/src/types.js';

function baseCart(): Cart {
  return {
    product_id: 'ch3_rug_001',
    merchant_domain: 'shop-a.example',
    unit_price_minor: 18900,
    qty: 1,
    currency: 'USD',
    line_items: [{ label: 'shipping', amount_minor: 0 }],
    shipping_days: 4,
    refundable: true,
    attrs_claimed: {},
  };
}

test('sealing is idempotent: the hash field is excluded from its own input', () => {
  const once = seal(baseCart());
  const twice = seal(once);
  assert.equal(once.cart_hash, twice.cart_hash);
});

test('a one-minor-unit change changes the cart hash', () => {
  const unit = seal(baseCart());
  const line = seal({ ...baseCart(), line_items: [{ label: 'shipping', amount_minor: 1 }] });
  const qty = seal({ ...baseCart(), qty: 2 });
  const currency = seal({ ...baseCart(), currency: 'EUR' });
  assert.notEqual(unit.cart_hash, line.cart_hash);
  assert.notEqual(unit.cart_hash, qty.cart_hash);
  assert.notEqual(unit.cart_hash, currency.cart_hash);
});

test('key order in the input does not change the seal', () => {
  const shuffled = {
    attrs_claimed: {},
    refundable: true,
    shipping_days: 4,
    line_items: [{ amount_minor: 0, label: 'shipping' }],
    currency: 'USD',
    qty: 1,
    unit_price_minor: 18900,
    merchant_domain: 'shop-a.example',
    product_id: 'ch3_rug_001',
  } as Cart;
  assert.equal(seal(baseCart()).cart_hash, seal(shuffled).cart_hash);
});
