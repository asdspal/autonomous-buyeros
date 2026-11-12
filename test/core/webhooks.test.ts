import assert from 'node:assert/strict';
import { test } from 'node:test';
import { verifyWebhook } from '../../packages/core/src/paypal/webhooks.js';

const credentials = {
  clientId: 'cid',
  clientSecret: 'sec',
  baseUrl: 'https://api-m.sandbox.paypal.com',
};

const headers = {
  transmissionId: 't1',
  transmissionTime: '2026-11-12T00:00:00Z',
  certUrl: 'https://api.paypal.com/cert',
  authAlgo: 'SHA256withRSA',
  transmissionSig: 'sig',
};

function stub(status: number, body: unknown, ok = true): typeof fetch {
  return (async (input: string | URL | Request) => {
    if (String(input).endsWith('/v1/oauth2/token')) {
      return new Response(JSON.stringify({ access_token: 'tok' }), { status: 200 });
    }
    if (!ok) return new Response('', { status });
    return new Response(JSON.stringify(body), { status });
  }) as typeof fetch;
}

test('verification succeeds only when PayPal says SUCCESS', async () => {
  const base = {
    webhookId: 'WH1',
    rawBody: JSON.stringify({ id: 'evt', event_type: 'PAYMENT.CAPTURE.COMPLETED' }),
    headers,
    credentials,
  };
  assert.equal(await verifyWebhook({ ...base, fetchImpl: stub(200, { verification_status: 'SUCCESS' }) }), true);
  assert.equal(await verifyWebhook({ ...base, fetchImpl: stub(200, { verification_status: 'FAILURE' }) }), false);
});

test('missing transmission headers fail closed', async () => {
  assert.equal(
    await verifyWebhook({
      webhookId: 'WH1',
      rawBody: '{}',
      headers: { ...headers, transmissionSig: null },
      credentials,
      fetchImpl: stub(200, { verification_status: 'SUCCESS' }),
    }),
    false,
  );
});

test('a non-200 verification response fails closed', async () => {
  assert.equal(
    await verifyWebhook({
      webhookId: 'WH1',
      rawBody: '{}',
      headers,
      credentials,
      fetchImpl: stub(500, {}, false),
    }),
    false,
  );
});
