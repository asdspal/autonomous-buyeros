export interface CompileContext {
  currency: string;
  issuer: string;
  agentCnf: string;
  allowedMerchants: string[];
  nowEpoch: number;
  maxTotalMinor: number;
  maxMeterMinor: number;
}

const NOUNS = [
  'rug',
  'desk',
  'chair',
  'lamp',
  'monitor',
  'mug',
  'mat',
  'table',
  'shelf',
  'sofa',
  'bed',
  'keyboard',
  'headphones',
];

export function normalizeItem(value: string): string {
  const text = value.toLowerCase().trim();
  const noun = NOUNS.find((candidate) => new RegExp(`\\b${candidate}s?\\b`).test(text));
  if (noun) return noun;
  return text.replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 32) || 'item';
}

function parseMoneyMinor(text: string, patterns: RegExp[]): number | null {
  for (const pattern of patterns) {
    const match = pattern.exec(text);
    if (match?.[1]) {
      const [whole, fraction = ''] = match[1].split('.');
      const minor = Number(whole) * 100 + Number(fraction.padEnd(2, '0').slice(0, 2));
      if (!Number.isInteger(minor)) return null;
      return minor;
    }
  }
  return null;
}

export interface DraftFields {
  status: 'ok' | 'refused';
  missing?: string[];
  budget_total_minor: number;
  per_txn_minor: number;
  max_txns: number;
  meter_total_minor: number;
  meter_per_call_minor: number;
  meter_max_calls: number;
  item: string;
  washable: boolean;
  returnable: boolean;
  merchants: string[];
  shipping_deadline_days: number;
  unknown_attribute_policy: 'deny' | 'escalate' | 'allow';
}

export interface TemplateResult {
  ok: boolean;
  fields?: DraftFields;
  missing: string[];
}

export function templateFields(brief: string, context: CompileContext): TemplateResult {
  const missing: string[] = [];
  const budgetMinor = parseMoneyMinor(brief, [
    /\$\s*(\d[\d,]*(?:\.\d{1,2})?)/,
    /(\d[\d,]*(?:\.\d{1,2})?)\s*(?:dollars|usd)/i,
    /under\s+(\d[\d,]*(?:\.\d{1,2})?)/i,
  ]);
  if (budgetMinor === null) missing.push('budget');

  const item = NOUNS.find((noun) => new RegExp(`\\b${noun}s?\\b`, 'i').test(brief)) ?? null;
  if (!item) missing.push('item');

  const merchants = context.allowedMerchants;
  if (merchants.length === 0) missing.push('merchant');
  if (missing.length > 0) return { ok: false, missing };

  const total = Math.min(budgetMinor!, context.maxTotalMinor);
  const toolBudget = /tool|lookup|call|credit/i.test(brief)
    ? Math.min(context.maxMeterMinor, Math.max(100, Math.floor(total / 20)))
    : Math.min(context.maxMeterMinor, 300);

  return {
    ok: true,
    missing: [],
    fields: {
      status: 'ok',
      budget_total_minor: total,
      per_txn_minor: Math.min(total, 20_000),
      max_txns: 1,
      meter_total_minor: toolBudget,
      meter_per_call_minor: Math.max(1, Math.min(toolBudget, 20)),
      meter_max_calls: Math.max(0, Math.min(500, Math.floor(toolBudget / 20))),
      item: item!,
      washable: /wash/i.test(brief),
      returnable: /return|refund/i.test(brief),
      merchants,
      shipping_deadline_days: 14,
      unknown_attribute_policy: 'escalate',
    },
  };
}
