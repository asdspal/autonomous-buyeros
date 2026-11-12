import assert from 'node:assert/strict';
import { test } from 'node:test';
import { RecordingAdapter } from '../../packages/core/src/paypal/adapter.js';
import { runCheckout } from '../../packages/core/src/checkout/orchestrator.js';
import { seal } from '../../packages/core/src/cart/seal.js';
import type { Cart, Catalog, Mandate, Verdict } from '../../packages/core/src/types.js';

const NOW = 1_850_000_000;

const mandate: Mandate = {
  mandate_id: 'mdt_skeleton0001',
  exp: NOW + 86_400,
  nonce: 'n_skeleton_000001',
  constraints: {
    budget: { currency: 'USD', total_minor: 25000, per_txn_minor: 20000, max_txns: 1 },
    merchants: { mode: 'allowlist', domain_hashes: ['shop-a.example'] },
    items: [
      {
        spec_id: 'rug',
        max_qty: 1,
        required_attrs: { machine_washable: { true: true } },
      },
    ],
    shipping: { deadline_days: 10 },
    unknown_attribute_policy: 'deny',
    refundability: { min: 'returnable' },
  },
};

const catalog: Catalog = { product_id: 'ch3_rug_001', attrs: { machine_washable: true } };

function cart(unitPriceMinor: number): Cart {
  return seal({
    product_id: 'ch3_rug_001',
    merchant_domain: 'shop-a.example',
    unit_price_minor: unitPriceMinor,
    qty: 1,
    currency: 'USD',
    line_items: [],
    shipping_days: 4,
    refundable: true,
    attrs_claimed: {},
  });
}

function memoryStore(journal: string[]) {
  const events: string[] = [];
  let verdict: Verdict | null = null;
  return {
    events,
    verdict: () => verdict,
    async saveAuthorization() {
      events.push('auth-stored');
    },
    async saveVerdict(value: Verdict) {
      events.push('verdict-stored');
      verdict = value;
      journal.push('verdict-stored');
      return 'vrd_skeleton0001';
    },
    async markCheckout(status: string) {
      events.push(`checkout:${status}`);
    },
  };
}

test('skeleton order is authorize -> verdict stored -> void', async () => {
  const journal: string[] = [];
  const adapter = new RecordingAdapter(
    {
      orderId: 'ord_skeleton0001',
      authorizationId: 'aut_skeleton0001',
      status: 'AUTHORIZED',
      amountMinor: 24900,
      currency: 'USD',
    },
    journal,
  );
  const store = memoryStore(journal);

  const result = await runCheckout({
    mandate,
    cart: cart(24900),
    catalog,
    usedNonces: new Set(),
    nowEpoch: NOW,
    adapter,
    store,
    journal,
  });

  assert.equal(result.verdict.decision, 'VOID');
  assert.ok(result.verdict.reason_codes.includes('MV-R002'));
  assert.deepEqual(journal, ['authorize', 'verdict', 'verdict-stored', 'void']);
  assert.deepEqual(
    adapter.calls.map((call) => call.action),
    ['createAuthorization', 'voidAuthorization'],
  );
  const voidCall = adapter.calls[1];
  assert.equal(voidCall && 'idempotencyKey' in voidCall ? voidCall.idempotencyKey : null, 'vrd_vrd_skeleton0001');
  assert.deepEqual(store.events.slice(-1), ['checkout:SETTLED']);
});

test('a compliant cart captures and never voids', async () => {
  const journal: string[] = [];
  const adapter = new RecordingAdapter(
    {
      orderId: 'ord_skeleton0002',
      authorizationId: 'aut_skeleton0002',
      status: 'AUTHORIZED',
      amountMinor: 18900,
      currency: 'USD',
    },
    journal,
  );
  const store = memoryStore(journal);

  const result = await runCheckout({
    mandate,
    cart: cart(18900),
    catalog,
    usedNonces: new Set(),
    nowEpoch: NOW,
    adapter,
    store,
    journal,
  });

  assert.equal(result.verdict.decision, 'CAPTURE');
  assert.deepEqual(journal, ['authorize', 'verdict', 'verdict-stored', 'capture']);
  const captureCall = adapter.calls[1];
  assert.equal(
    captureCall && 'idempotencyKey' in captureCall ? captureCall.idempotencyKey : null,
    'vrd_vrd_skeleton0001',
  );
});

test('an authorization whose amount differs from the sealed cart is refused before any money call', async () => {
  const journal: string[] = [];
  const adapter = new RecordingAdapter(
    {
      orderId: 'ord_skeleton0003',
      authorizationId: 'aut_skeleton0003',
      status: 'AUTHORIZED',
      amountMinor: 1,
      currency: 'USD',
    },
    journal,
  );
  const store = memoryStore(journal);
  await assert.rejects(
    runCheckout({
      mandate,
      cart: cart(18900),
      catalog,
      usedNonces: new Set(),
      nowEpoch: NOW,
      adapter,
      store,
      journal,
    }),
    /AMOUNT_MISMATCH/,
  );
  assert.deepEqual(
    adapter.calls.map((call) => call.action),
    ['createAuthorization'],
  );
  assert.deepEqual(store.events.slice(-1), ['checkout:NEEDS_ATTENTION']);
});
