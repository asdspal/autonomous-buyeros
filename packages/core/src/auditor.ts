import { digest } from './canonical.js';
import { R } from './reason-codes.js';
import type {
  Cart,
  Catalog,
  Clause,
  Decision,
  Mandate,
  Result,
  Verdict,
} from './types.js';

const PASS: Result = 'PASS';
const FAIL: Result = 'FAIL';
const UNKNOWN: Result = 'UNKNOWN';

const CAPTURE: Decision = 'CAPTURE';
const VOID: Decision = 'VOID';
const ESCALATE: Decision = 'ESCALATE';

function compare(op: string, observed: unknown, expected: unknown): Result {
  if (observed === null || observed === undefined) return UNKNOWN;
  switch (op) {
    case 'eq':
      return observed === expected ? PASS : FAIL;
    case 'in':
      return Array.isArray(expected) && expected.includes(observed) ? PASS : FAIL;
    case 'gte':
      return typeof observed === 'number' && typeof expected === 'number'
        ? observed >= expected ? PASS : FAIL
        : UNKNOWN;
    case 'lte':
      return typeof observed === 'number' && typeof expected === 'number'
        ? observed <= expected ? PASS : FAIL
        : UNKNOWN;
    case 'true':
      return observed === true ? PASS : FAIL;
    default:
      throw new Error(`unknown operator ${op}`);
  }
}

function resolveAttribute(
  cart: Cart,
  catalog: Catalog | null,
  name: string,
): { observed: unknown; source: string } {
  const attrs = (catalog?.attrs ?? {}) as Record<string, unknown>;
  if (name in attrs) return { observed: attrs[name], source: 'catalog' };
  const claimed = cart.attrs_claimed ?? {};
  if (name in claimed) return { observed: null, source: 'merchant_claim_untrusted' };
  return { observed: null, source: 'absent' };
}

export function evaluate(
  mandate: Mandate,
  cart: Cart,
  catalog: Catalog | null,
  usedNonces: Set<string>,
  nowEpoch: number,
  txnCount = 0,
  extraClauses: Clause[] = [],
): Verdict {
  const clauses: Clause[] = [];
  const constraints = mandate.constraints;

  const add = (
    clauseId: string,
    expression: string,
    observed: unknown,
    source: string,
    result: Result,
    code = '',
  ): void => {
    clauses.push({ clause_id: clauseId, expression, observed, source, result, code });
  };

  const expired = nowEpoch >= mandate.exp;
  add('C-00', 'mandate.exp > now', mandate.exp, 'mandate', expired ? FAIL : PASS, R.expired);
  const replayed = usedNonces.has(mandate.nonce);
  add('C-01', 'mandate.nonce unused', mandate.nonce, 'mandate', replayed ? FAIL : PASS, R.replay);

  const lineItems = cart.line_items ?? [];
  const total =
    cart.unit_price_minor * cart.qty +
    lineItems.reduce((sum, item) => sum + item.amount_minor, 0);

  add(
    'C-02',
    'cart.currency == mandate.currency',
    cart.currency,
    'cart',
    cart.currency === constraints.budget.currency ? PASS : FAIL,
    R.currency,
  );
  add(
    'C-03',
    'cart.total <= mandate.total_minor',
    total,
    'cart:computed',
    total <= constraints.budget.total_minor ? PASS : FAIL,
    R.budget_total,
  );
  // ponytail: the per-transaction cap is compared against the unit price, matching the
  // normative spike. Move it to the cart total once the schema decision is made.
  add(
    'C-04',
    'cart.unit_price <= mandate.per_txn_minor',
    cart.unit_price_minor,
    'cart',
    cart.unit_price_minor <= constraints.budget.per_txn_minor ? PASS : FAIL,
    R.per_txn,
  );
  add(
    'C-05',
    'txn_count < mandate.max_txns',
    txnCount,
    'vault',
    txnCount < constraints.budget.max_txns ? PASS : FAIL,
    R.per_txn,
  );

  const allow = constraints.merchants;
  const merchantOk =
    allow.mode === 'any' || (allow.domain_hashes ?? []).includes(cart.merchant_domain);
  add(
    'C-06',
    'cart.merchant in mandate.merchants',
    cart.merchant_domain,
    'cart',
    merchantOk ? PASS : FAIL,
    R.merchant,
  );

  const ship = cart.shipping_days;
  const shippingOk = typeof ship === 'number' && ship <= constraints.shipping.deadline_days;
  add(
    'C-07',
    'cart.shipping_days <= mandate.shipping.deadline_days',
    ship ?? null,
    'cart',
    shippingOk ? PASS : ship === null || ship === undefined ? UNKNOWN : FAIL,
    R.shipping,
  );

  if (constraints.refundability) {
    const want = constraints.refundability.min;
    const observed = cart.refundable;
    const result: Result =
      want === 'returnable'
        ? observed === true ? PASS : observed === false ? FAIL : UNKNOWN
        : PASS;
    add('C-08', 'cart.refundable == true', observed ?? null, 'cart', result, R.refundability);
  }

  const cartForHash: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(cart)) {
    if (key !== 'cart_hash') cartForHash[key] = value;
  }
  const cartHash = digest(cartForHash);
  add(
    'C-09',
    'sha256(jcs(cart)) == cart.cart_hash',
    cartHash,
    'cart:computed',
    cartHash === cart.cart_hash ? PASS : FAIL,
    R.cart_hash,
  );
  const productOk = catalog === null || cart.product_id === catalog.product_id;
  add(
    'C-10',
    'cart.product_id == catalog.product_id',
    cart.product_id,
    catalog ? 'catalog' : 'absent',
    productOk ? PASS : FAIL,
    R.amount,
  );

  constraints.items.forEach((item, index) => {
    const required = item.required_attrs ?? {};
    for (const name of Object.keys(required).sort()) {
      const spec = required[name];
      if (!spec) continue;
      const entry = Object.entries(spec)[0];
      if (!entry) continue;
      const [op, expected] = entry;
      const { observed, source } = resolveAttribute(cart, catalog, name);
      const result = compare(op, observed, expected);
      add(
        `C-2${index}-${name}`,
        `${name} ${op} ${JSON.stringify(expected)}`,
        observed,
        source,
        result,
        result === FAIL ? R.attr_mismatch : R.attr_unknown,
      );
    }
    add(
      `C-3${index}-qty`,
      'cart.qty <= mandate.max_qty',
      cart.qty,
      'cart',
      cart.qty <= item.max_qty ? PASS : FAIL,
      R.per_txn,
    );
  });

  for (const clause of extraClauses) clauses.push(clause);

  const fails = clauses.filter((clause) => clause.result === FAIL);
  const unknowns = clauses.filter((clause) => clause.result === UNKNOWN);

  let decision: Decision;
  let reasons: string[];
  if (fails.length > 0) {
    decision = VOID;
    reasons = [...new Set(fails.map((clause) => clause.code).filter(Boolean))].sort();
  } else if (unknowns.length > 0) {
    const policy = constraints.unknown_attribute_policy ?? 'deny';
    if (policy === 'allow') {
      decision = CAPTURE;
      reasons = [];
    } else if (policy === 'escalate') {
      decision = ESCALATE;
      reasons = [...new Set(unknowns.map((clause) => clause.code).filter(Boolean))].sort();
    } else {
      decision = VOID;
      reasons = [
        ...new Set([
          ...unknowns.map((clause) => clause.code).filter(Boolean),
          R.unknown_policy_deny,
        ]),
      ].sort();
    }
  } else {
    decision = CAPTURE;
    reasons = [];
  }

  const evidenceHash = digest({
    mandate_id: mandate.mandate_id,
    cart_hash: cartHash,
    decision,
    reasons,
    clauses,
  });

  return { decision, reason_codes: reasons, clauses, evidence_hash: evidenceHash };
}
