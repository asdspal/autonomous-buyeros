import { z } from 'zod';

const currency = z.string().regex(/^[A-Z]{3}$/, 'ISO-4217 uppercase');
const attrOp = z
  .object({
    eq: z.unknown().optional(),
    in: z.array(z.unknown()).optional(),
    gte: z.number().int().optional(),
    lte: z.number().int().optional(),
    true: z.boolean().optional(),
  })
  .refine((value) => Object.keys(value).length === 1, 'exactly one operator');

export const mandateSchema = z
  .object({
    vct: z.literal('mandate.checkout.open.1'),
    mandate_id: z.string().regex(/^mdt_[a-z0-9]{12,}$/),
    issuer: z.string().regex(/^principal:[a-z0-9]{4,64}$/),
    agent_cnf: z.string().regex(/^jkt:[A-Za-z0-9_-]{8,64}$/),
    nonce: z.string().min(16).max(64),
    iat: z.number().int().min(0),
    exp: z.number().int().min(0),
    constraints: z
      .object({
        budget: z
          .object({
            currency,
            total_minor: z.number().int().min(1).max(5_000_000),
            per_txn_minor: z.number().int().min(1).max(5_000_000),
            max_txns: z.number().int().min(1).max(20),
          })
          .superRefine((value, ctx) => {
            if (value.per_txn_minor > value.total_minor) {
              ctx.addIssue({ code: 'custom', message: 'per_txn_minor <= total_minor' });
            }
          }),
        metering: z.object({
          currency,
          total_minor: z.number().int().min(0).max(50_000),
          per_call_minor: z.number().int().min(1).max(5_000),
          max_calls: z.number().int().min(0).max(500),
        }),
        merchants: z.object({
          mode: z.enum(['allowlist', 'any']),
          domain_hashes: z.array(z.string()).default([]),
        }),
        items: z
          .array(
            z.object({
              spec_id: z.string().min(1),
              max_qty: z.number().int().min(1).max(10),
              required_attrs: z.record(z.string(), attrOp).default({}),
              negotiation: z
                .object({
                  allowed: z.boolean().optional(),
                  min_discount_bp: z.number().int().min(0).max(5000).optional(),
                })
                .optional(),
            }),
          )
          .min(1)
          .max(5),
        shipping: z.object({
          deadline_days: z.number().int().min(1).max(120),
        }),
        unknown_attribute_policy: z.enum(['deny', 'escalate', 'allow']),
        refundability: z
          .object({ min: z.enum(['returnable', 'any']) })
          .optional(),
      })
      .superRefine((value, ctx) => {
        if (value.metering.per_call_minor > value.metering.total_minor && value.metering.total_minor !== 0) {
          ctx.addIssue({ code: 'custom', message: 'meter per_call <= meter total' });
        }
        if (value.metering.currency !== value.budget.currency) {
          ctx.addIssue({ code: 'custom', message: 'one currency per mandate' });
        }
      }),
  })
  .superRefine((value, ctx) => {
    if (value.exp <= value.iat) {
      ctx.addIssue({ code: 'custom', path: ['exp'], message: 'exp > iat' });
    }
    if (value.exp - value.iat > 2_592_000) {
      ctx.addIssue({ code: 'custom', path: ['exp'], message: 'lifetime <= 30 days' });
    }
  });

export type MandateDraft = z.infer<typeof mandateSchema>;

export interface SchemaIssue {
  path: string;
  message: string;
}

export function parseMandate(input: unknown):
  | { ok: true; mandate: MandateDraft }
  | { ok: false; issues: SchemaIssue[] } {
  const result = mandateSchema.safeParse(input);
  if (result.success) return { ok: true, mandate: result.data };
  return {
    ok: false,
    issues: result.error.issues.map((issue) => ({
      path: issue.path.join('.'),
      message: issue.message,
    })),
  };
}
