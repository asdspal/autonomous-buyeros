export const R = {
  budget_total: 'MV-R001',
  per_txn: 'MV-R002',
  merchant: 'MV-R003',
  attr_mismatch: 'MV-R004',
  attr_unknown: 'MV-R005',
  expired: 'MV-R006',
  replay: 'MV-R007',
  cart_hash: 'MV-R008',
  amount: 'MV-R009',
  refundability: 'MV-R010',
  shipping: 'MV-R011',
  currency: 'MV-R012',
  unknown_policy_deny: 'MV-R013',
  revoked: 'MV-R014',
  signature: 'MV-R015',
  agent_binding: 'MV-R016',
  brief_uncompilable: 'MV-R017',
  offer_signature: 'MV-R018',
  offer_stale: 'MV-R019',
  offer_total: 'MV-R020',
  offer_not_honoured: 'MV-R021',
  offer_unknown_key: 'MV-R022',
  meter_exhausted: 'MV-R023',
  voucher_invalid: 'MV-R024',
  meter_reconcile: 'MV-R025',
  over_capture: 'MV-R026',
} as const;

export type ReasonCode = (typeof R)[keyof typeof R];

export type Result = 'PASS' | 'FAIL' | 'UNKNOWN';
export type Decision = 'CAPTURE' | 'VOID' | 'ESCALATE';

export interface Clause {
  clause_id: string;
  expression: string;
  observed: unknown;
  source: string;
  result: Result;
  code: string;
}

export interface Verdict {
  decision: Decision;
  reason_codes: string[];
  clauses: Clause[];
  evidence_hash: string;
}

export interface Mandate {
  mandate_id: string;
  exp: number;
  nonce: string;
  constraints: {
    budget: { currency: string; total_minor: number; per_txn_minor: number; max_txns: number };
    merchants: { mode: 'allowlist' | 'any'; domain_hashes?: string[] };
    items: Array<{
      spec_id: string;
      max_qty: number;
      required_attrs?: Record<string, Record<string, unknown>>;
      negotiation?: { allowed?: boolean; min_discount_bp?: number };
    }>;
    shipping: { deadline_days: number };
    unknown_attribute_policy?: 'deny' | 'escalate' | 'allow';
    refundability?: { min: 'returnable' | 'any' };
    metering?: {
      currency: string;
      total_minor: number;
      per_call_minor: number;
      max_calls: number;
    };
  };
}

export interface Cart {
  product_id: string;
  merchant_domain: string;
  unit_price_minor: number;
  qty: number;
  currency: string;
  line_items?: Array<{ amount_minor: number; label?: string }>;
  shipping_days?: number | null;
  refundable?: boolean | null;
  attrs_claimed?: Record<string, unknown>;
  cart_hash?: string;
  offer_id?: string;
}

export interface Catalog {
  product_id: string;
  merchant_domain?: string;
  attrs?: Record<string, unknown>;
}

export class GuardError extends Error {
  readonly code: string;
  constructor(code: string) {
    super(code);
    this.name = 'GuardError';
    this.code = code;
  }
}
