import { evaluate } from '../auditor.js';
import type { Cart, Catalog, Mandate, Verdict } from '../types.js';
import type { AuthorizationRecord, PayPalAdapter } from '../paypal/adapter.js';
import { assertSettlePreconditions, attentionReasonFromError } from './guards.js';

export interface CheckoutStore {
  saveAuthorization(record: AuthorizationRecord): Promise<void>;
  saveVerdict(verdict: Verdict, latencyUs: number): Promise<string>;
  markCheckout(status: 'SETTLED' | 'FAILED_PAYPAL' | 'NEEDS_ATTENTION'): Promise<void>;
  markAuthorizationStatus?(
    authorizationId: string,
    status: 'VOIDED' | 'CAPTURED',
    capturedMinor?: number,
  ): Promise<void>;
}

export interface RunCheckoutInput {
  mandate: Mandate;
  cart: Cart;
  catalog: Catalog | null;
  usedNonces: Set<string>;
  nowEpoch: number;
  adapter: PayPalAdapter;
  store: CheckoutStore;
  journal?: string[];
}

export interface RunCheckoutResult {
  authorization: AuthorizationRecord;
  verdict: Verdict;
  verdictId: string;
  settlement: 'captured' | 'voided' | 'held';
}

export async function runCheckout(input: RunCheckoutInput): Promise<RunCheckoutResult> {
  const { mandate, cart, catalog, usedNonces, nowEpoch, adapter, store } = input;
  const journal = input.journal ?? [];

  const expectedTotal = cartTotalMinor(cart);
  const authorization = await adapter.createAuthorization({
    amountMinor: cartTotalMinor(cart),
    currency: cart.currency,
    description: `Checkout ${cart.product_id}`,
    customId: `cart:${cart.cart_hash ?? 'unsealed'}`,
  });
  await store.saveAuthorization(authorization);

  const startedAt = process.hrtime.bigint();
  const verdict = evaluate(mandate, cart, catalog, usedNonces, nowEpoch, 0);
  const latencyUs = Number((process.hrtime.bigint() - startedAt) / 1000n);
  journal.push('verdict');
  const verdictId = await store.saveVerdict(verdict, latencyUs);

  try {
    assertSettlePreconditions({ verdict, authorization, expectedTotalMinor: expectedTotal });
    if (verdict.decision === 'CAPTURE') {
      await adapter.captureAuthorization(
        authorization.authorizationId,
        expectedTotal,
        true,
        `vrd_${verdictId}`,
      );
      await store.markAuthorizationStatus?.(
        authorization.authorizationId,
        'CAPTURED',
        cartTotalMinor(cart),
      );
      await store.markCheckout('SETTLED');
      return { authorization, verdict, verdictId, settlement: 'captured' };
    }
    if (verdict.decision === 'VOID') {
      await adapter.voidAuthorization(authorization.authorizationId, `vrd_${verdictId}`);
      await store.markAuthorizationStatus?.(authorization.authorizationId, 'VOIDED');
      await store.markCheckout('SETTLED');
      return { authorization, verdict, verdictId, settlement: 'voided' };
    }
    return { authorization, verdict, verdictId, settlement: 'held' };
  } catch (error) {
    const reason = attentionReasonFromError(error);
    const isRefusal =
      reason === 'AMOUNT_MISMATCH' ||
      reason === 'CAPTURE_WITHOUT_VERDICT' ||
      reason === 'PAYMENT_SOURCE_REQUIRES_ACTION';
    await store.markCheckout(
      !isRefusal && verdict.decision === 'CAPTURE' ? 'FAILED_PAYPAL' : 'NEEDS_ATTENTION',
    );
    throw error;
  }
}

export function cartTotalMinor(cart: Cart): number {
  return (
    cart.unit_price_minor * cart.qty +
    (cart.line_items ?? []).reduce((sum, item) => sum + item.amount_minor, 0)
  );
}
