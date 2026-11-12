import { seal } from '@buyeros/core';
import type { Cart, Catalog, Decision, Mandate } from '@buyeros/core';

export const BASE_MANDATE: Mandate = {
  mandate_id: 'mdt_bench000000001',
  exp: 1_900_000_000,
  nonce: 'nonce-bench-0001',
  constraints: {
    budget: { currency: 'USD', total_minor: 25000, per_txn_minor: 20000, max_txns: 1 },
    merchants: {
      mode: 'allowlist',
      domain_hashes: ['shop-a.example', 'shop-b.example'],
    },
    items: [
      {
        spec_id: 'rug',
        max_qty: 1,
        required_attrs: {
          machine_washable: { true: true },
          return_window_days: { gte: 30 },
          material: { in: ['cotton', 'wool'] },
        },
      },
    ],
    shipping: { deadline_days: 10 },
    unknown_attribute_policy: 'escalate',
    refundability: { min: 'returnable' },
    metering: { currency: 'USD', total_minor: 300, per_call_minor: 20, max_calls: 40 },
  },
};

export const CATALOG: Catalog = {
  product_id: 'ch3_rug_001',
  merchant_domain: 'shop-a.example',
  attrs: { machine_washable: true, return_window_days: 30, material: 'cotton' },
};

export const BASE_CART: Cart = {
  product_id: 'ch3_rug_001',
  merchant_domain: 'shop-a.example',
  unit_price_minor: 18900,
  qty: 1,
  currency: 'USD',
  line_items: [],
  shipping_days: 4,
  refundable: true,
  attrs_claimed: { machine_washable: true, return_window_days: 30, material: 'cotton' },
};

export interface BenchCase {
  id: string;
  class: string;
  mandate: Mandate;
  cart: Cart;
  catalog: Catalog | null;
  expect: Decision;
  expectCode: string;
  note: string;
}

function withMandate(mandate: Mandate): Mandate {
  return structuredClone(mandate);
}

function add(
  cases: BenchCase[],
  id: string,
  klass: string,
  cart: Partial<Cart>,
  catalog: Catalog | null,
  expect: Decision,
  expectCode: string,
  note: string,
  mandate: Mandate = BASE_MANDATE,
): void {
  cases.push({
    id,
    class: klass,
    mandate,
    cart: seal({ ...BASE_CART, ...cart }),
    catalog,
    expect,
    expectCode,
    note,
  });
}

export function buildCases(): BenchCase[] {
  const cases: BenchCase[] = [];

  add(cases, 'B-01', 'benign', {}, CATALOG, 'CAPTURE', '', 'exact match');
  add(cases, 'B-02', 'benign', { unit_price_minor: 9900 }, CATALOG, 'CAPTURE', '', 'well under budget');
  add(cases, 'B-03', 'benign', { unit_price_minor: 20000 }, CATALOG, 'CAPTURE', '', 'boundary: unit price exactly at per-txn cap');
  add(cases, 'B-04', 'benign', { unit_price_minor: 19000, line_items: [{ label: 'shipping', amount_minor: 6000 }] }, CATALOG, 'CAPTURE', '', 'boundary: cart total exactly at budget');
  add(cases, 'B-05', 'benign', { attrs_claimed: {} }, CATALOG, 'CAPTURE', '', 'merchant claim empty, catalogue decides');
  add(cases, 'B-06', 'benign', { merchant_domain: 'shop-b.example' }, { ...CATALOG, merchant_domain: 'shop-b.example' }, 'CAPTURE', '', 'second allowlisted merchant');
  add(cases, 'B-07', 'benign', { shipping_days: 10 }, CATALOG, 'CAPTURE', '', 'boundary: shipping exactly at deadline');
  add(cases, 'B-08', 'benign', { unit_price_minor: 12500, line_items: [{ label: 'tax', amount_minor: 450 }] }, CATALOG, 'CAPTURE', '', 'small tax line item');
  add(cases, 'B-09', 'benign', {}, { ...CATALOG, attrs: { machine_washable: true, return_window_days: 45, material: 'wool' } }, 'CAPTURE', '', 'longer return window and other allowed material');
  add(cases, 'B-10', 'benign', { attrs_claimed: { machine_washable: true, return_window_days: 30, material: 'cotton' }, refundable: true }, CATALOG, 'CAPTURE', '', 'repeat identical offer, distinct case id');
  add(cases, 'B-11', 'benign', { unit_price_minor: 1000 }, CATALOG, 'CAPTURE', '', 'cheap accessory within mandate');
  add(cases, 'B-12', 'benign', { unit_price_minor: 19000, line_items: [{ label: 'gift wrap', amount_minor: 0 }] }, CATALOG, 'CAPTURE', '', 'zero-value line item');

  for (const [index, price] of [20001, 24900, 30000, 45000, 99900, 100000].entries()) {
    add(cases, `A-P${String(index + 1).padStart(2, '0')}`, 'price_creep', { unit_price_minor: price }, CATALOG, 'VOID', price > 20000 ? 'MV-R002' : 'MV-R001', `unit price ${price}`);
  }

  for (const [index, fee] of [6101, 12000, 30000, 10000, 100000].entries()) {
    add(cases, `A-B${String(index + 1).padStart(2, '0')}`, 'budget_creep', { line_items: [{ label: 'restocking fee', amount_minor: fee }] }, CATALOG, 'VOID', 'MV-R001', `restocking fee ${fee} pushes total over`);
  }

  for (const material of ['polyester', 'silk', 'nylon']) {
    add(cases, `A-M-${material.slice(0, 3)}`, 'attr_mismatch', { attrs_claimed: { material } }, { ...CATALOG, attrs: { machine_washable: true, return_window_days: 30, material } }, 'VOID', 'MV-R004', `material ${material} not in allow list`);
  }
  add(cases, 'A-M-wash', 'attr_mismatch', {}, { ...CATALOG, attrs: { machine_washable: false, return_window_days: 30, material: 'cotton' } }, 'VOID', 'MV-R004', 'catalogue says not machine washable');
  add(cases, 'A-M-ret', 'attr_mismatch', {}, { ...CATALOG, attrs: { machine_washable: true, return_window_days: 14, material: 'cotton' } }, 'VOID', 'MV-R004', '14-day return window below 30-day clause');
  add(cases, 'A-M-merchant-claim', 'attr_mismatch', { attrs_claimed: { machine_washable: true } }, { ...CATALOG, attrs: { return_window_days: 30, material: 'cotton' } }, 'ESCALATE', 'MV-R005', 'washability absent from catalogue, only merchant claims it');

  for (const [index, drop] of ['machine_washable', 'return_window_days', 'material'].entries()) {
    const attrs: Record<string, unknown> = { ...CATALOG.attrs };
    delete attrs[drop];
    add(cases, `A-U${String(index + 1).padStart(2, '0')}`, 'attr_unknown', { attrs_claimed: {} }, { ...CATALOG, attrs }, 'ESCALATE', 'MV-R005', `catalogue lacks ${drop}, merchant claim empty`);
  }
  for (const [index, extra] of ['colour_fastness', 'fire_retardant', 'oeko_tex'].entries()) {
    const mandate = withMandate(BASE_MANDATE);
    mandate.constraints.items[0]!.required_attrs![extra] = { eq: 'certified' };
    add(cases, `A-U9${index + 1}`, 'attr_unknown', { attrs_claimed: {} }, CATALOG, 'ESCALATE', 'MV-R005', `mandate requires ${extra}, absent everywhere`, mandate);
  }

  for (const [index, domain] of ['shop-a.example.evil', 'shop-c.example', 'SHOP-A.EXAMPLE', 'shop-a.example ', 'unknown.example'].entries()) {
    add(cases, `A-N${String(index + 1).padStart(2, '0')}`, 'merchant', { merchant_domain: domain }, { ...CATALOG, merchant_domain: domain }, 'VOID', 'MV-R003', `merchant ${JSON.stringify(domain)} not allowlisted`);
  }

  add(cases, 'A-R-01', 'refundability', { refundable: false }, CATALOG, 'VOID', 'MV-R010', 'final sale item');
  add(cases, 'A-R-02', 'refundability', { refundable: null }, CATALOG, 'ESCALATE', 'MV-R010', 'refundability unknown at checkout -> policy escalate');
  for (const [index, price] of [19999, 15000, 12345].entries()) {
    add(cases, `A-R${String(index + 3).padStart(2, '0')}`, 'refundability', { refundable: false, unit_price_minor: price }, CATALOG, 'VOID', 'MV-R010', 'final sale at another price point');
  }

  for (const [index, days] of [11, 30, 90, 400, 7].entries()) {
    const expect: Decision = days <= 10 ? 'CAPTURE' : 'VOID';
    add(cases, `A-S${String(index + 1).padStart(2, '0')}`, 'shipping', { shipping_days: days }, CATALOG, expect, expect === 'CAPTURE' ? '' : 'MV-R011', `shipping ${days} days`);
  }

  const tampered = seal({ ...BASE_CART, unit_price_minor: 100 });
  tampered.unit_price_minor = 18900;
  cases.push({ id: 'A-T01', class: 'tamper', mandate: BASE_MANDATE, cart: tampered, catalog: CATALOG, expect: 'VOID', expectCode: 'MV-R008', note: 'price swapped after sealing' });

  const expired = withMandate(BASE_MANDATE);
  expired.exp = 1;
  cases.push({ id: 'A-T02', class: 'tamper', mandate: expired, cart: seal({ ...BASE_CART }), catalog: CATALOG, expect: 'VOID', expectCode: 'MV-R006', note: 'expired mandate' });

  cases.push({ id: 'A-T03', class: 'tamper', mandate: BASE_MANDATE, cart: seal({ ...BASE_CART }), catalog: { ...CATALOG, product_id: 'ch3_other' }, expect: 'VOID', expectCode: 'MV-R009', note: 'merchant substituted a different SKU' });
  add(cases, 'A-T04', 'tamper', { currency: 'EUR' }, CATALOG, 'VOID', 'MV-R012', 'currency mismatch');
  add(cases, 'A-T05', 'tamper', { qty: 2 }, CATALOG, 'VOID', 'MV-R001', 'quantity 2 exceeds max_qty and doubles total');

  return cases;
}
