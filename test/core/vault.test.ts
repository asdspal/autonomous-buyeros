import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  createSetupToken,
  exchangeSetupToken,
} from '../../packages/core/src/paypal/vault.js';

function fetchStub(responses: Array<{ status: number; body: unknown }>): {
  impl: typeof fetch;
  calls: Array<{ url: string; body: unknown }>;
} {
  const calls: Array<{ url: string; body: unknown }> = [];
  let index = 0;
  const impl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    const raw = typeof init?.body === 'string' ? init.body : null;
    calls.push({ url, body: raw && raw.startsWith('{') ? JSON.parse(raw) : raw });
    if (url.endsWith('/v1/oauth2/token')) {
      return new Response(JSON.stringify({ access_token: 'tok' }), { status: 200 });
    }
    const response = responses[index++];
    if (!response) throw new Error('stub exhausted');
    return new Response(JSON.stringify(response.body), { status: response.status });
  }) as typeof fetch;
  return { impl, calls };
}

const credentials = {
  clientId: 'cid',
  clientSecret: 'sec',
  baseUrl: 'https://api-m.sandbox.paypal.com',
};

test('a setup token returns the payer approval link and never a vault id', async () => {
  const stub = fetchStub([
    {
      status: 201,
      body: {
        id: 'SETUP123456',
        status: 'PAYER_ACTION_REQUIRED',
        links: [
          { rel: 'self', href: 'x' },
          { rel: 'approve', href: 'https://www.sandbox.paypal.com/agreements/approve?approval_session_id=SETUP123456' },
        ],
      },
    },
  ]);
  const result = await createSetupToken({ ...credentials, fetchImpl: stub.impl });
  assert.equal(result.setupTokenId, 'SETUP123456');
  assert.match(result.approveUrl, /approval_session_id=SETUP123456/);
  assert.equal('vaultId' in result, false);
  const request = stub.calls[1]!.body as {
    payment_source: { paypal: { usage_pattern: string; customer_type: string } };
  };
  assert.equal(request.payment_source.paypal.usage_pattern, 'IMMEDIATE');
  assert.equal(request.payment_source.paypal.customer_type, 'CONSUMER');
});

test('exchanging a setup token yields the vault id', async () => {
  const stub = fetchStub([
    { status: 201, body: { id: 'VAULT987', payment_source: { paypal: { payer_id: 'PAYER1' } } } },
  ]);
  const result = await exchangeSetupToken({ ...credentials, fetchImpl: stub.impl }, 'SETUP123456');
  assert.deepEqual(result, { vaultId: 'VAULT987', payerId: 'PAYER1' });
  const request = stub.calls[1]!.body as { payment_source: { token: { id: string; type: string } } };
  assert.deepEqual(request.payment_source.token, { id: 'SETUP123456', type: 'SETUP_TOKEN' });
});

test('a missing token is refused, not silently ignored', async () => {
  const stub = fetchStub([{ status: 422, body: { details: [{ issue: 'TOKEN_EXPIRED' }] } }]);
  await assert.rejects(
    exchangeSetupToken({ ...credentials, fetchImpl: stub.impl }, 'SETUP123456'),
    /TOKEN_EXPIRED/,
  );
});
