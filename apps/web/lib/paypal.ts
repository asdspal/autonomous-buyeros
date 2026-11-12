import {
  CircuitBreaker,
  PayPalRestAdapter,
  RetryingPayPalAdapter,
  type BreakerState,
} from '@buyeros/core';

let breaker: CircuitBreaker | null = null;
let adapter: RetryingPayPalAdapter | null = null;

export function paypalAdapter(): RetryingPayPalAdapter {
  if (!adapter) {
    breaker = new CircuitBreaker(5, 30_000);
    const rest = new PayPalRestAdapter({
      clientId: process.env.PAYPAL_CLIENT_ID ?? '',
      clientSecret: process.env.PAYPAL_CLIENT_SECRET ?? '',
      baseUrl: process.env.PAYPAL_API_BASE ?? 'https://api-m.sandbox.paypal.com',
      vaultId: process.env.PAYPAL_VAULT_ID,
    });
    adapter = new RetryingPayPalAdapter(rest, { breaker, attempts: 3 });
  }
  return adapter;
}

export function paypalBreakerState(): BreakerState {
  return breaker?.state() ?? 'closed';
}
