import { expect, test } from '@playwright/test';

const draft = {
  vct: 'mandate.checkout.open.1',
  mandate_id: 'mdt_e2esign000001',
  issuer: 'principal:priya01',
  agent_cnf: 'jkt:agentdemo0001',
  nonce: 'n_e2e_sign_00000001',
  iat: 1_793_000_000,
  exp: 1_795_592_000,
  constraints: {
    budget: { currency: 'USD', total_minor: 25000, per_txn_minor: 20000, max_txns: 1 },
    metering: { currency: 'USD', total_minor: 300, per_call_minor: 20, max_calls: 40 },
    merchants: { mode: 'allowlist', domain_hashes: ['shop-a.example'] },
    items: [{ spec_id: 'rug', max_qty: 1, required_attrs: { machine_washable: { true: true } } }],
    shipping: { deadline_days: 10 },
    unknown_attribute_policy: 'escalate',
    refundability: { min: 'returnable' },
  },
};

test('signing sends only the public key and no private material', async ({ page }) => {
  await page.route('**/api/auth/demo', (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: '{"authenticated":true}' }),
  );
  await page.route('**/api/mandates/compile', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ status: 'ok', mandate: draft, source: 'template' }),
    });
  });

  let posted: string | null = null;
  await page.route('**/api/mandates', async (route) => {
    posted = route.request().postData() ?? '';
    await route.fulfill({
      status: 201,
      contentType: 'application/json',
      body: JSON.stringify({ mandateId: draft.mandate_id, version: 1, clauses: 9, status: 'ACTIVE' }),
    });
  });

  await page.goto('/mandates/new');
  await page.getByRole('button', { name: 'Compile draft' }).click();
  await expect(page.getByRole('heading', { name: 'Read every clause before signing' })).toBeVisible();
  await page.getByLabel('I have read every clause and confirm this mandate.').check();
  await page.getByRole('button', { name: 'Sign and activate' }).click();
  await expect(page.getByRole('status')).toContainText('ACTIVE');

  expect(posted).not.toBeNull();
  const body = JSON.parse(posted as unknown as string) as {
    publicJwk: Record<string, unknown>;
    signature: string;
  };
  expect('d' in body.publicJwk).toBe(false);
  expect(JSON.stringify(body)).not.toMatch(/"d":/);
  expect(body.publicJwk.kty).toBe('EC');
  expect(body.signature.length).toBeGreaterThan(40);
});
