import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  CircuitBreaker,
  RetryingPayPalAdapter,
  isRetryable,
} from '../../packages/core/src/paypal/retry.js';
import { RecordingAdapter } from '../../packages/core/src/paypal/adapter.js';
import type { AuthorizationRecord, PayPalAdapter } from '../../packages/core/src/paypal/adapter.js';
import { GuardError } from '../../packages/core/src/types.js';

const auth: AuthorizationRecord = {
  orderId: 'o',
  authorizationId: 'a',
  status: 'AUTHORIZED',
  amountMinor: 100,
  currency: 'USD',
};

function flaky(failures: number, message = 'PAYPAL_503_UNAVAILABLE'): {
  adapter: PayPalAdapter;
  calls: Array<{ attempt: number; key?: string }>;
} {
  const calls: Array<{ attempt: number; key?: string }> = [];
  let attempt = 0;
  const adapter: PayPalAdapter = {
    async createAuthorization() {
      attempt += 1;
      calls.push({ attempt });
      if (attempt <= failures) throw new GuardError(message);
      return auth;
    },
    async captureAuthorization(_id, _amount, _final, key) {
      attempt += 1;
      calls.push({ attempt, key });
      if (attempt <= failures) throw new GuardError(message);
      return { captureId: 'c', status: 'COMPLETED', amountMinor: 100 };
    },
    async voidAuthorization() {},
    async getAuthorization() {
      return auth;
    },
  };
  return { adapter, calls };
}

test('a 5xx is retried with the same idempotency key and then succeeds', async () => {
  const { adapter, calls } = flaky(1);
  const retrying = new RetryingPayPalAdapter(adapter, {
    attempts: 3,
    sleep: async () => undefined,
  });
  const result = await retrying.captureAuthorization('a', 100, true, 'vrd_1');
  assert.equal(result.status, 'COMPLETED');
  assert.equal(calls.length, 2);
  assert.deepEqual(calls.map((call) => call.key), ['vrd_1', 'vrd_1']);
});

test('a 422 is permanent and is not retried', async () => {
  const { adapter, calls } = flaky(9, 'PAYPAL_422_VALIDATION');
  const retrying = new RetryingPayPalAdapter(adapter, {
    attempts: 3,
    sleep: async () => undefined,
  });
  await assert.rejects(retrying.captureAuthorization('a', 100, true), /422/);
  assert.equal(calls.length, 1);
});

test('a 429 is retryable, a 404 is not', () => {
  assert.equal(isRetryable(new GuardError('PAYPAL_429_RATE_LIMITED')), true);
  assert.equal(isRetryable(new GuardError('PAYPAL_500_INTERNAL')), true);
  assert.equal(isRetryable(new GuardError('PAYPAL_404_NOT_FOUND')), false);
  assert.equal(isRetryable(new GuardError('PAYPAL_422_VALIDATION')), false);
});

test('the breaker opens after five consecutive failures and refuses fast', async () => {
  let clock = 0;
  const breaker = new CircuitBreaker(5, 30_000, () => clock);
  const failing: PayPalAdapter = {
    async createAuthorization() {
      throw new GuardError('PAYPAL_500_DOWN');
    },
    async captureAuthorization() {
      throw new GuardError('PAYPAL_500_DOWN');
    },
    async voidAuthorization() {
      throw new GuardError('PAYPAL_500_DOWN');
    },
    async getAuthorization() {
      return null;
    },
  };
  const retrying = new RetryingPayPalAdapter(failing, {
    attempts: 1,
    breaker,
    sleep: async () => undefined,
  });
  for (let i = 0; i < 5; i += 1) {
    await assert.rejects(retrying.createAuthorization({ amountMinor: 1, currency: 'USD', description: 'x', customId: 'x' }));
  }
  assert.equal(retrying.breakerState(), 'open');
  await assert.rejects(
    retrying.createAuthorization({ amountMinor: 1, currency: 'USD', description: 'x', customId: 'x' }),
    /BREAKER_OPEN/,
  );
  clock = 30_001;
  assert.equal(retrying.breakerState(), 'half_open');
});

test('a success resets the failure count', async () => {
  const breaker = new CircuitBreaker(2, 30_000, () => 0);
  const inner = new RecordingAdapter(auth);
  const retrying = new RetryingPayPalAdapter(inner, { breaker });
  await retrying.createAuthorization({ amountMinor: 1, currency: 'USD', description: 'x', customId: 'x' });
  assert.equal(retrying.breakerState(), 'closed');
  assert.equal(inner.calls.length, 1);
});
