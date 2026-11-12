import { randomUUID } from 'node:crypto';
import { NextResponse } from 'next/server';
import { PayPalRestAdapter, runCheckout, seal } from '@buyeros/core';
import { correlationId, withCorrelation } from '../../../lib/correlation';
import {
  ensureSkeletonWorld,
  insertCheckout,
  pgCheckoutStore,
  skeletonCart,
  skeletonCatalog,
  skeletonMandate,
} from '../../../lib/skeleton';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(request: Request) {
  const id = correlationId(request);

  if (process.env.DEMO_MODE !== 'on') {
    const token = request.headers.get('x-service-token');
    if (!token || token !== process.env.SERVICE_TOKEN) {
      return withCorrelation(NextResponse.json({ error: 'UNAUTHENTICATED' }, { status: 401 }), id);
    }
  }

  const body = (await request.json().catch(() => ({}))) as { requestKey?: string };
  const requestKey =
    typeof body.requestKey === 'string' && body.requestKey.length >= 16
      ? body.requestKey
      : `req_${randomUUID()}`;

  const required = ['PAYPAL_CLIENT_ID', 'PAYPAL_CLIENT_SECRET', 'PAYPAL_API_BASE', 'PAYPAL_VAULT_ID'];
  const missing = required.filter((name) => !process.env[name]);
  if (missing.length) {
    return withCorrelation(
      NextResponse.json({ error: 'CONFIG_MISSING', missing }, { status: 500 }),
      id,
    );
  }

  try {
    await ensureSkeletonWorld();
    const cart = seal(skeletonCart());
    const totalMinor = cart.unit_price_minor * cart.qty;
    const checkout = await insertCheckout(requestKey, cart.cart_hash, totalMinor);

    if (checkout.status !== 'PENDING') {
      return withCorrelation(
        NextResponse.json({ replayed: true, checkoutId: checkout.id, status: checkout.status }),
        id,
      );
    }

    const adapter = new PayPalRestAdapter({
      clientId: process.env.PAYPAL_CLIENT_ID!,
      clientSecret: process.env.PAYPAL_CLIENT_SECRET!,
      baseUrl: process.env.PAYPAL_API_BASE!,
      vaultId: process.env.PAYPAL_VAULT_ID!,
    });

    const result = await runCheckout({
      mandate: skeletonMandate,
      cart,
      catalog: skeletonCatalog,
      usedNonces: new Set(),
      nowEpoch: Math.floor(Date.now() / 1000),
      adapter,
      store: pgCheckoutStore(checkout.id),
    });

    const body = {
      checkoutId: checkout.id,
      verdictId: result.verdictId,
      decision: result.verdict.decision,
      reason_codes: result.verdict.reason_codes,
      settlement: result.settlement,
      paypal: {
        order_id: result.authorization.orderId,
        authorization_id: result.authorization.authorizationId,
        amount_minor: result.authorization.amountMinor,
      },
      evidence_hash: result.verdict.evidence_hash,
    };
    console.log(JSON.stringify({ level: 'info', msg: 'checkout.decided', correlation_id: id, ...body }));
    return withCorrelation(NextResponse.json(body, { status: 200 }), id);
  } catch (error) {
    const message = error instanceof Error ? error.message : 'UNKNOWN';
    console.error(JSON.stringify({ level: 'error', msg: 'checkout.failed', correlation_id: id, error: message }));
    return withCorrelation(
      NextResponse.json({ error: 'CHECKOUT_FAILED', detail: message }, { status: 502 }),
      id,
    );
  }
}
