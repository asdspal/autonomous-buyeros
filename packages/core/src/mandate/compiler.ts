import { parseMandate } from './schema.js';
import type { MandateDraft, SchemaIssue } from './schema.js';
import { normalizeItem, templateFields } from './templates.js';
import type { CompileContext, DraftFields } from './templates.js';
import { chatJson } from '../llm/client.js';

export type { CompileContext } from './templates.js';

export type CompileResult =
  | { status: 'ok'; mandate: MandateDraft; source: 'model' | 'template' }
  | { status: 'refused'; missing: string[]; message: string; source: 'model' | 'template' };

export interface ModelConfig {
  apiKey: string;
  baseUrl: string;
  model: string;
  fetchImpl?: typeof fetch;
}

const FIELD_SCHEMA: Record<string, unknown> = {
  type: 'object',
  additionalProperties: false,
  required: [
    'status',
    'missing',
    'budget_total_minor',
    'per_txn_minor',
    'max_txns',
    'meter_total_minor',
    'meter_per_call_minor',
    'meter_max_calls',
    'item',
    'washable',
    'returnable',
    'merchants',
    'shipping_deadline_days',
    'unknown_attribute_policy',
  ],
  properties: {
    status: { type: 'string', enum: ['ok', 'refused'] },
    missing: { type: 'array', items: { type: 'string' } },
    budget_total_minor: { type: 'integer', minimum: 0 },
    per_txn_minor: { type: 'integer', minimum: 0 },
    max_txns: { type: 'integer', minimum: 0 },
    meter_total_minor: { type: 'integer', minimum: 0 },
    meter_per_call_minor: { type: 'integer', minimum: 0 },
    meter_max_calls: { type: 'integer', minimum: 0 },
    item: { type: 'string' },
    washable: { type: 'boolean' },
    returnable: { type: 'boolean' },
    merchants: { type: 'array', items: { type: 'string' } },
    shipping_deadline_days: { type: 'integer', minimum: 0 },
    unknown_attribute_policy: { type: 'string', enum: ['deny', 'escalate', 'allow'] },
  },
};

const SYSTEM = [
  'You compile a shopping brief into a spending mandate draft. Return JSON only.',
  'Never invent an amount, merchant or item that the brief does not support.',
  'If the brief lacks an amount, an item, or an allowed merchant, set status to refused.',
  'Caps are ceilings, not suggestions: never exceed the maximums in the context.',
  'Money is integer minor units. Do not output prose.',
].join(' ');

function clamp(fields: DraftFields, context: CompileContext): { fields: DraftFields; missing: string[] } {
  const missing: string[] = [];
  const total = Math.max(0, Math.min(Math.trunc(fields.budget_total_minor), context.maxTotalMinor));
  if (total < 100) missing.push('budget');
  const perTxn = Math.max(1, Math.min(Math.trunc(fields.per_txn_minor), total || 1));
  const meterTotal = Math.max(0, Math.min(Math.trunc(fields.meter_total_minor), context.maxMeterMinor, 50_000));
  const meterPerCall = Math.max(1, Math.min(Math.trunc(fields.meter_per_call_minor), Math.max(1, meterTotal)));
  const meterMaxCalls = Math.max(0, Math.min(Math.trunc(fields.meter_max_calls), 500));
  const merchants = (fields.merchants ?? []).filter((domain) => context.allowedMerchants.includes(domain));
  if (context.allowedMerchants.length > 0 && merchants.length === 0) missing.push('merchant');
  const rawItem = String(fields.item ?? '').trim();
  const item = rawItem ? normalizeItem(rawItem) : '';
  if (!item) missing.push('item');
  const policy = ['deny', 'escalate', 'allow'].includes(fields.unknown_attribute_policy)
    ? fields.unknown_attribute_policy
    : 'escalate';
  return {
    missing,
    fields: {
      status: missing.length ? 'refused' : 'ok',
      budget_total_minor: total,
      per_txn_minor: perTxn,
      max_txns: Math.max(1, Math.min(Math.trunc(fields.max_txns), 20)),
      meter_total_minor: meterTotal,
      meter_per_call_minor: meterPerCall,
      meter_max_calls: meterMaxCalls,
      item,
      washable: Boolean(fields.washable),
      returnable: Boolean(fields.returnable),
      merchants,
      shipping_deadline_days: Math.max(1, Math.min(Math.trunc(fields.shipping_deadline_days), 120)),
      unknown_attribute_policy: policy,
    },
  };
}

function buildMandate(fields: DraftFields, context: CompileContext): MandateDraft {
  return {
    vct: 'mandate.checkout.open.1',
    mandate_id: `mdt_compiled${String(context.nowEpoch).slice(-6)}`,
    issuer: context.issuer,
    agent_cnf: context.agentCnf,
    nonce: `n_${context.nowEpoch}_${Math.random().toString(36).slice(2, 12)}`,
    iat: context.nowEpoch,
    exp: context.nowEpoch + 86_400,
    constraints: {
      budget: {
        currency: context.currency,
        total_minor: fields.budget_total_minor,
        per_txn_minor: fields.per_txn_minor,
        max_txns: fields.max_txns,
      },
      metering: {
        currency: context.currency,
        total_minor: fields.meter_total_minor,
        per_call_minor: fields.meter_per_call_minor,
        max_calls: fields.meter_max_calls,
      },
      merchants: { mode: 'allowlist', domain_hashes: fields.merchants },
      items: [
        {
          spec_id: fields.item,
          max_qty: 1,
          required_attrs: fields.washable ? { machine_washable: { true: true } } : {},
        },
      ],
      shipping: { deadline_days: fields.shipping_deadline_days },
      unknown_attribute_policy: fields.unknown_attribute_policy,
      refundability: { min: fields.returnable ? 'returnable' : 'any' },
    },
  };
}

function normalizeMissing(missing: string[]): string[] {
  const groups = new Set<string>();
  for (const field of missing) {
    if (/^(budget|per_txn|max_txns|meter_)/.test(field)) groups.add('budget');
    else if (field === 'item') groups.add('item');
    else if (field.startsWith('merchant')) groups.add('merchant');
    else if (field.startsWith('shipping')) groups.add('shipping');
    else if (field === 'unknown_attribute_policy') groups.add('policy');
  }
  return [...groups];
}

function refusal(missing: string[], source: 'model' | 'template'): CompileResult {
  const normalized = normalizeMissing(missing);
  return {
    status: 'refused',
    missing: normalized,
    message: `The brief is missing: ${normalized.join(', ')}`,
    source,
  };
}

function fromFields(fields: DraftFields, context: CompileContext, source: 'model' | 'template'): CompileResult {
  const clamped = clamp(fields, context);
  if (clamped.missing.length > 0) return refusal(clamped.missing, source);
  const mandate = buildMandate(clamped.fields, context);
  const parsed = parseMandate(mandate);
  if (!parsed.ok) {
    return refusal(
      parsed.issues.map((issue: SchemaIssue) => issue.path || issue.message),
      source,
    );
  }
  return { status: 'ok', mandate: parsed.mandate, source };
}

export async function compileBrief(
  brief: string,
  context: CompileContext,
  model?: ModelConfig,
): Promise<CompileResult> {
  if (model?.apiKey) {
    try {
      const result = (await chatJson({
        apiKey: model.apiKey,
        baseUrl: model.baseUrl,
        model: model.model,
        system: SYSTEM,
        user: JSON.stringify({
          brief,
          context: {
            currency: context.currency,
            allowed_merchants: context.allowedMerchants,
            max_total_minor: context.maxTotalMinor,
            max_meter_minor: context.maxMeterMinor,
          },
        }),
        schemaName: 'MandateDraft',
        schema: FIELD_SCHEMA,
        fetchImpl: model.fetchImpl,
      })) as DraftFields;
      if (result.status === 'refused') {
        return refusal(result.missing && result.missing.length ? result.missing : ['budget'], 'model');
      }
      return fromFields(result, context, 'model');
    } catch {
      // fall through to the deterministic template
    }
  }

  const templated = templateFields(brief, context);
  if (!templated.ok || !templated.fields) return refusal(templated.missing, 'template');
  return fromFields(templated.fields, context, 'template');
}

export function modelFromEnv(fetchImpl?: typeof fetch): ModelConfig | undefined {
  const apiKey = process.env.LLM_API_KEY;
  if (!apiKey) return undefined;
  return {
    apiKey,
    baseUrl: process.env.LLM_BASE_URL ?? 'https://api.fireworks.ai/inference/v1',
    model: process.env.LLM_MODEL ?? 'accounts/fireworks/models/deepseek-v4p1-flash-1017',
    fetchImpl,
  };
}
