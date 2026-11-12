import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Meter } from '../../packages/core/src/meter.js';

test('per-call cap, allowance and max calls refuse with named codes', () => {
  const meter = new Meter({ budgetMinor: 100, perCallMinor: 60, maxCalls: 2 });
  assert.throws(() => meter.authorize(61, 'a'), /PER_CALL_CAP_EXCEEDED/);
  assert.ok(meter.authorize(60, 'b'));
  assert.throws(() => meter.authorize(60, 'c'), /METER_BUDGET_EXCEEDED/);

  const capped = new Meter({ budgetMinor: 1000, perCallMinor: 1, maxCalls: 2 });
  assert.ok(capped.authorize(1, 'a'));
  assert.ok(capped.authorize(1, 'b'));
  assert.throws(() => capped.authorize(1, 'c'), /MAX_CALLS_EXCEEDED/);
});

test('a voucher is single-use and price and call bound', () => {
  const meter = new Meter({ budgetMinor: 1000, perCallMinor: 100, maxCalls: 10 });
  const nonce = meter.authorize(40, 'h1');
  meter.redeem(nonce, 'h1', 40);
  assert.throws(() => meter.redeem(nonce, 'h1', 40), /VOUCHER_REDEEMED/);
  assert.throws(() => meter.redeem(nonce, 'h1', 41), /VOUCHER_REDEEMED/);
  assert.throws(() => meter.redeem('v_missing', 'h1', 40), /UNKNOWN_VOUCHER/);

  const other = new Meter({ budgetMinor: 1000, perCallMinor: 100, maxCalls: 10 });
  const second = other.authorize(40, 'h1');
  assert.throws(() => other.redeem(second, 'h2', 40), /VOUCHER_CALL_MISMATCH/);
  assert.throws(() => other.redeem(second, 'h1', 39), /VOUCHER_PRICE_MISMATCH/);
});

test('an expired voucher is released and never captured', () => {
  const meter = new Meter({ budgetMinor: 1000, perCallMinor: 100, maxCalls: 10, ttlS: 60 });
  const kept = meter.authorize(40, 'used');
  meter.redeem(kept, 'used', 40);
  meter.authorize(25, 'lapsed');
  meter.advance(61);
  assert.equal(meter.expireOpen(), 25);
  assert.equal(meter.captured, 40);
  assert.equal(meter.releasedTotal, 25);
  assert.equal(meter.outstanding, 40);

  const plan = meter.settlePlan();
  assert.deepEqual(plan, {
    capture_minor: 40,
    final_capture: true,
    void_remainder_minor: 960,
  });
});

test('settle plan refuses to capture above the authorization', () => {
  const meter = new Meter({ budgetMinor: 10, perCallMinor: 100, maxCalls: 10 });
  const nonce = meter.authorize(10, 'a');
  meter.redeem(nonce, 'a', 10);
  assert.equal(meter.settlePlan().capture_minor, 10);
  assert.throws(() => {
    (meter as unknown as { redeemed: number }).redeemed = 11;
    meter.settlePlan();
  }, /CAPTURE_EXCEEDS_AUTHORIZATION/);
});

test('allowance accounting is exact across many calls', () => {
  const meter = new Meter({ budgetMinor: 5000, perCallMinor: 100, maxCalls: 2000 });
  let issued = 0;
  let redeemed = 0;
  const prices = [1, 2, 5, 10, 25, 50];
  for (let i = 0; i < 200; i += 1) {
    const price = prices[i % prices.length]!;
    const call = `call_${i}`;
    const nonce = meter.authorize(price, call);
    issued += 1;
    meter.redeem(nonce, call, price);
    redeemed += price;
  }
  assert.equal(issued, 200);
  assert.equal(meter.captured, redeemed);
  assert.equal(meter.outstanding, redeemed);
  assert.equal(redeemed, 33 * (1 + 2 + 5 + 10 + 25 + 50) + 1 + 2);
  assert.equal(meter.settlePlan().capture_minor, redeemed);
});
