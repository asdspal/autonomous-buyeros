import { randomUUID } from 'node:crypto';
import { NextResponse } from 'next/server';
import {
  PayPalRestAdapter,
  beginIdempotency,
  canonical,
  clearIdempotency,
  finishIdempotency,
  rateLimit,
  runCheckout,
  seal,
  sha256Hex,
} from '@buyeros/core';
import { correlationId, withCorrelation } from '../../../lib/correlation';
import { agentAuth, serviceAuthorised, sessionPrincipal } from '../../../lib/auth';
import {
  ensureSkeletonWorld,
  insertCheckout,
  pgCheckoutStore,
  poolInstance,
  skeletonCart,
  skeletonCatalog,
  skeletonMandate,
} from '../../../lib/skeleton';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(request: Request) {
  const id = correlationId(request);

  const raw = await request.text();
  let body: { requestKey?: string } = {};
  try {
    body = raw ? (JSON.parse(raw) as { requestKey?: string }) : {};
  } catch {
    return withCorrelation(NextResponse.json({ error: 'INVALID_JSON' }, { status: 400 }), id);
  }

  const hasAgentHeaders =
    request.headers.has('x-agent-jwk') || request.headers.has('x-agent-signature');
  let identity: string | null = null;
  if (hasAgentHeaders) {
    const agent = await agentAuth(request, body, poolInstance());
    if (!agent.ok) {
      return withCorrelation(
        NextResponse.json(
          { error: { code: agent.code, message: 'agent key does not match a registered agent' } },
          { status: 403 },
        ),
        id,
      );
    }
    identity = agent.agentThumbprint!;
    const decision = await rateLimit(poolInstance(), 'checkout-agent', identity, 10);
    if (!decision.allowed) {
      return withCorrelation(
        NextResponse.json(
          { error: { code: 'RATE_LIMITED', retry_after_seconds: decision.retryAfterSeconds } },
          { status: 429, headers: { 'retry-after': String(decision.retryAfterSeconds) } },
        ),
        id,
      );
    }
  } else if (serviceAuthorised(request) || (await sessionPrincipal(request))) {
    identity = 'prn_demo';
    const decision = await rateLimit(poolInstance(), 'checkout-principal', identity, 20);
    if (!decision.allowed) {
      return withCorrelation(
        NextResponse.json(
          { error: { code: 'RATE_LIMITED', retry_after_seconds: decision.retryAfterSeconds } },
          { status: 429, headers: { 'retry-after': String(decision.retryAfterSeconds) } },
        ),
        id,
      );
    }
  } else {
    return withCorrelation(NextResponse.json({ error: 'UNAUTHENTICATED' }, { status: 401 }), id);
  }

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

  const requestHash = sha256Hex(canonical(body));
  const idempotency = await beginIdempotency(poolInstance(), 'checkout', requestKey, requestHash);
  if (idempotency.state === 'replay') {
    return withCorrelation(
      NextResponse.json(idempotency.body, { status: idempotency.code }),
      id,
    );
  }
  if (idempotency.state === 'in_flight') {
    return withCorrelation(
      NextResponse.json(
        { error: 'IDEMPOTENT_RETRY_IN_FLIGHT', requestKey },
        { status: 409, headers: { 'retry-after': '1' } },
      ),
      id,
    );
  }
  if (idempotency.state === 'reused') {
    return withCorrelation(
      NextResponse.json(
        { error: 'IDEMPOTENCY_KEY_REUSED', message: 'the request key was used with another body' },
        { status: 409 },
      ),
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
    await finishIdempotency(poolInstance(), 'checkout', requestKey, 200, body, checkout.id);
    console.log(JSON.stringify({ level: 'info', msg: 'checkout.decided', correlation_id: id, ...body }));
    return withCorrelation(NextResponse.json(body, { status: 200 }), id);
  } catch (error) {
    await clearIdempotency(poolInstance(), 'checkout', requestKey).catch(() => undefined);
    const message = error instanceof Error ? error.message : 'UNKNOWN';
    console.error(JSON.stringify({ level: 'error', msg: 'checkout.failed', correlation_id: id, error: message }));
    return withCorrelation(
      NextResponse.json({ error: 'CHECKOUT_FAILED', detail: message }, { status: 502 }),
      id,
    );
  }
}
