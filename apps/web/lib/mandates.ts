import { randomUUID } from 'node:crypto';
import type { Pool } from 'pg';
import { canonical, sha256Hex, type MandateDraft } from '@buyeros/core';

export const DEMO_PRINCIPAL_ID = 'prn_demo';

export function requireDemoOrService(request: Request): Response | null {
  if (process.env.DEMO_MODE === 'on') return null;
  const token = request.headers.get('x-service-token');
  if (!token || token !== process.env.SERVICE_TOKEN) {
    return Response.json({ error: 'UNAUTHENTICATED' }, { status: 401 });
  }
  return null;
}

export async function ensurePrincipal(db: Pool): Promise<void> {
  await db.query(
    `INSERT INTO principal (id, email, display_name)
     VALUES ($1, 'priya@example.com', 'Priya')
     ON CONFLICT (id) DO NOTHING`,
    [DEMO_PRINCIPAL_ID],
  );
}

export async function registerAgent(db: Pool, keyThumbprint: string): Promise<string> {
  const id = `agt_${sha256Hex(keyThumbprint).slice(0, 12)}`;
  await db.query(
    `INSERT INTO agent (id, principal_id, display_name, key_thumbprint)
     VALUES ($1,$2,'reference agent',$3)
     ON CONFLICT (key_thumbprint) DO NOTHING`,
    [id, DEMO_PRINCIPAL_ID, keyThumbprint],
  );
  const { rows } = await db.query<{ id: string }>(
    'SELECT id FROM agent WHERE key_thumbprint = $1',
    [keyThumbprint],
  );
  return rows[0]!.id;
}

export async function registerPrincipalKey(
  db: Pool,
  jwk: unknown,
  thumbprint: string,
): Promise<void> {
  await db.query(
    `INSERT INTO principal_key (id, principal_id, jwk, thumbprint)
     VALUES ($1,$2,$3::jsonb,$4)
     ON CONFLICT (thumbprint) DO NOTHING`,
    [`pky_${randomUUID()}`, DEMO_PRINCIPAL_ID, JSON.stringify(jwk), thumbprint],
  );
}

interface ClauseRow {
  key: string;
  text: string;
  expression: Record<string, unknown>;
}

function formatMoney(minor: number, currency: string): string {
  return `${(minor / 100).toFixed(2)} ${currency}`;
}

export function clausesFromMandate(mandate: MandateDraft): ClauseRow[] {
  const rows: ClauseRow[] = [];
  const c = mandate.constraints;
  rows.push({
    key: 'budget.total',
    text: `Total spend at most ${formatMoney(c.budget.total_minor, c.budget.currency)}`,
    expression: { field: 'cart.total_minor', op: 'lte', value: c.budget.total_minor },
  });
  rows.push({
    key: 'budget.per_txn',
    text: `Each transaction at most ${formatMoney(c.budget.per_txn_minor, c.budget.currency)}`,
    expression: { field: 'cart.unit_price_minor', op: 'lte', value: c.budget.per_txn_minor },
  });
  rows.push({
    key: 'budget.max_txns',
    text: `At most ${c.budget.max_txns} transactions`,
    expression: { field: 'txn_count', op: 'lt', value: c.budget.max_txns },
  });
  rows.push({
    key: 'merchants',
    text:
      c.merchants.mode === 'any'
        ? 'Any merchant'
        : `Merchant must be one of: ${c.merchants.domain_hashes.join(', ')}`,
    expression: {
      field: 'cart.merchant_domain',
      op: c.merchants.mode === 'any' ? 'any' : 'in',
      value: c.merchants.domain_hashes,
    },
  });
  rows.push({
    key: 'shipping.deadline',
    text: `Delivery within ${c.shipping.deadline_days} days`,
    expression: { field: 'cart.shipping_days', op: 'lte', value: c.shipping.deadline_days },
  });
  rows.push({
    key: 'unknown_attribute_policy',
    text: `Unknown attributes: ${c.unknown_attribute_policy}`,
    expression: { field: 'unknown_attribute_policy', op: 'eq', value: c.unknown_attribute_policy },
  });
  if (c.refundability) {
    rows.push({
      key: 'refundability',
      text: `Refundable: ${c.refundability.min}`,
      expression: { field: 'cart.refundable', op: 'eq', value: c.refundability.min === 'returnable' },
    });
  }
  for (const item of c.items) {
    rows.push({
      key: `items.${item.spec_id}.max_qty`,
      text: `At most ${item.max_qty} of ${item.spec_id}`,
      expression: { field: 'cart.qty', op: 'lte', value: item.max_qty },
    });
    for (const [attr, spec] of Object.entries(item.required_attrs)) {
      const [op, value] = Object.entries(spec)[0]!;
      rows.push({
        key: `items.${item.spec_id}.${attr}`,
        text: `${attr} ${op} ${JSON.stringify(value)}`,
        expression: { field: `attrs.${attr}`, op, value },
      });
    }
  }
  return rows;
}

export interface StoreMandateInput {
  mandate: MandateDraft;
  signature: string;
  jwk: unknown;
  principalKeyThumbprint: string;
  agentId: string;
}

export async function storeMandate(
  db: Pool,
  input: StoreMandateInput,
): Promise<{ mandateId: string; version: number; clauses: number }> {
  const { mandate, signature, jwk, principalKeyThumbprint, agentId } = input;
  const c = mandate.constraints;
  const clauses = clausesFromMandate(mandate);
  const client = await db.connect();
  try {
    await client.query('BEGIN');
    await registerPrincipalKey(client as unknown as Pool, jwk, principalKeyThumbprint);
    await client.query(
      `INSERT INTO mandate (
         id, principal_id, agent_id, status, currency, purchase_total_minor,
         per_txn_minor, max_txns, meter_total_minor, meter_per_call_minor, meter_max_calls,
         unknown_attribute_policy, constraints, nonce, iat_epoch, exp_epoch, signature,
         signed_payload_sha256
       ) VALUES ($1,$2,$3,'ACTIVE',$4,$5,$6,$7,$8,$9,$10,$11,$12::jsonb,$13,$14,$15,$16,$17)`,
      [
        mandate.mandate_id,
        DEMO_PRINCIPAL_ID,
        agentId,
        c.budget.currency,
        c.budget.total_minor,
        c.budget.per_txn_minor,
        c.budget.max_txns,
        c.metering.total_minor,
        c.metering.per_call_minor,
        c.metering.max_calls,
        c.unknown_attribute_policy,
        JSON.stringify(c),
        mandate.nonce,
        mandate.iat,
        mandate.exp,
        signature,
        sha256Hex(canonical(mandate)),
      ],
    );
    for (const clause of clauses) {
      await client.query(
        `INSERT INTO mandate_clause (id, mandate_id, clause_key, expression, human_text)
         VALUES ($1,$2,$3,$4::jsonb,$5)`,
        [`mcl_${randomUUID()}`, mandate.mandate_id, clause.key, JSON.stringify(clause.expression), clause.text],
      );
    }
    await client.query(
      `INSERT INTO mandate_usage (mandate_id) VALUES ($1) ON CONFLICT DO NOTHING`,
      [mandate.mandate_id],
    );
    await client.query('COMMIT');
    return { mandateId: mandate.mandate_id, version: 1, clauses: clauses.length };
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}
