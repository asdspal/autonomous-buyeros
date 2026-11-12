import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { sha256Hex } from '@buyeros/core';
import type {
  AuthorizationRecord,
  CheckoutStore,
  Mandate,
  Cart,
  Catalog,
  Verdict,
} from '@buyeros/core';

const PRINCIPAL_ID = 'prn_demo';
const AGENT_ID = `agt_${sha256Hex('jkt:agentdemo0001').slice(0, 12)}`;
const MERCHANT_ID = 'mch_demo';
const MANDATE_ID = 'mdt_skeleton0001';
const DOMAIN = 'shop-a.example';
const PRODUCT_ID = 'ch3_rug_001';

export const skeletonMandate: Mandate = {
  mandate_id: MANDATE_ID,
  exp: 1_795_592_000,
  nonce: 'n_skeleton_000001',
  constraints: {
    budget: { currency: 'USD', total_minor: 25000, per_txn_minor: 20000, max_txns: 1 },
    merchants: { mode: 'allowlist', domain_hashes: [DOMAIN] },
    items: [{ spec_id: 'rug', max_qty: 1, required_attrs: { machine_washable: { true: true } } }],
    shipping: { deadline_days: 10 },
    unknown_attribute_policy: 'deny',
    refundability: { min: 'returnable' },
  },
};

export const skeletonCatalog: Catalog = {
  product_id: PRODUCT_ID,
  attrs: { machine_washable: true },
};

let pool: Pool | null = null;

export function poolInstance(): Pool {
  if (!pool) {
    const connectionString = process.env.DATABASE_URL;
    if (!connectionString) throw new Error('DATABASE_URL is not set');
    pool = new Pool({ connectionString, max: 4 });
  }
  return pool;
}

export async function ensureSkeletonWorld(): Promise<void> {
  const db = poolInstance();
  await db.query(
    `INSERT INTO principal (id, email, display_name)
     VALUES ($1, 'priya@example.com', 'Priya')
     ON CONFLICT (id) DO NOTHING`,
    [PRINCIPAL_ID],
  );
  await db.query(
    `INSERT INTO agent (id, principal_id, display_name, key_thumbprint)
     VALUES ($1, $2, 'reference agent', 'jkt:agentdemo0001')
     ON CONFLICT (key_thumbprint) DO NOTHING`,
    [AGENT_ID, PRINCIPAL_ID],
  );
  const agent = await db.query<{ id: string }>(
    'SELECT id FROM agent WHERE key_thumbprint = $1',
    ['jkt:agentdemo0001'],
  );
  await db.query(
    `INSERT INTO merchant (id, domain, display_name, execution_class)
     VALUES ($1, $2, 'Demo Store A', 'API_HOLD')
     ON CONFLICT (id) DO NOTHING`,
    [MERCHANT_ID, DOMAIN],
  );
  await db.query(
    `INSERT INTO mandate (
       id, principal_id, agent_id, status, currency, purchase_total_minor,
       per_txn_minor, max_txns, constraints, nonce, iat_epoch, exp_epoch, signature
     ) VALUES ($1,$2,$3,'ACTIVE','USD',25000,20000,1,'{}'::jsonb,'n_skeleton_000001',
               1793000000,1795592000,'skeleton')
     ON CONFLICT (id) DO NOTHING`,
    [MANDATE_ID, PRINCIPAL_ID, agent.rows[0]!.id],
  );
}

export interface CheckoutRow {
  id: string;
  request_key: string;
  correlation_id: string;
  status: string;
  cart_hash: string;
}

export async function insertCheckout(
  requestKey: string,
  cartHash: string,
  totalMinor: number,
): Promise<CheckoutRow> {
  const db = poolInstance();
  const correlationId = randomUUID();
  const checkoutId = `ckt_${randomUUID()}`;
  const result = await db.query<CheckoutRow>(
    `INSERT INTO checkout (
       id, principal_id, mandate_id, merchant_domain, request_key, cart_hash,
       total_minor, currency, execution_class, status, correlation_id
     ) VALUES ($1,$2,$3,$4,$5,$6,$7,'USD','API_HOLD','PENDING',$8)
     ON CONFLICT (mandate_id, request_key) DO NOTHING
     RETURNING id, request_key, correlation_id, status, cart_hash`,
    [checkoutId, PRINCIPAL_ID, MANDATE_ID, DOMAIN, requestKey, cartHash, totalMinor, correlationId],
  );
  if (result.rowCount && result.rows[0]) return result.rows[0];
  const existing = await db.query<CheckoutRow>(
    `SELECT id, request_key, correlation_id, status, cart_hash
     FROM checkout WHERE mandate_id = $1 AND request_key = $2`,
    [MANDATE_ID, requestKey],
  );
  return existing.rows[0]!;
}

export function pgCheckoutStore(checkoutId: string): CheckoutStore {
  const db = poolInstance();
  return {
    async saveAuthorization(record: AuthorizationRecord): Promise<void> {
      await db.query(
        `INSERT INTO paypal_authorization (
           id, purpose, checkout_id, order_id, authorization_id, amount_minor,
           currency, captured_minor, status, idempotency_key
         ) VALUES ($1,'PURCHASE',$2,$3,$4,$5,$6,0,'AUTHORIZED',$7)`,
        [
          `aut_${randomUUID()}`,
          checkoutId,
          record.orderId,
          record.authorizationId,
          record.amountMinor,
          record.currency,
          `create:${checkoutId}`,
        ],
      );
      await db.query(`UPDATE checkout SET status = 'AUTHORIZED', updated_at = now() WHERE id = $1`, [
        checkoutId,
      ]);
    },
    async saveVerdict(verdict: Verdict, latencyUs: number): Promise<string> {
      const verdictId = `vrd_${randomUUID()}`;
      const client = await db.connect();
      try {
        await client.query('BEGIN');
        await client.query(
          `INSERT INTO verdict (
             id, checkout_id, decision, reason_codes, evidence_hash, mandate_version,
             auditor_version, latency_us, correlation_id
           ) VALUES ($1,$2,$3,$4::jsonb,$5,1,'skeleton-0.1',$6,$7)`,
          [
            verdictId,
            checkoutId,
            verdict.decision,
            JSON.stringify(verdict.reason_codes),
            verdict.evidence_hash.replace(/^sha256:/, ''),
            latencyUs,
            randomUUID(),
          ],
        );
        for (const clause of verdict.clauses) {
          await client.query(
            `INSERT INTO verdict_clause (
               id, verdict_id, clause_key, clause_id, expression, observed, source, result, code
             ) VALUES ($1,$2,$3,$4,$5::jsonb,$6::jsonb,$7,$8,$9)`,
            [
              `vcl_${randomUUID()}`,
              verdictId,
              clause.clause_id,
              clause.clause_id,
              JSON.stringify({ text: clause.expression }),
              JSON.stringify(clause.observed ?? null),
              clause.source,
              clause.result,
              clause.code || null,
            ],
          );
        }
        await client.query(
          `UPDATE checkout SET status = 'SETTLE_PENDING', updated_at = now() WHERE id = $1`,
          [checkoutId],
        );
        await client.query('COMMIT');
        return verdictId;
      } catch (error) {
        await client.query('ROLLBACK');
        throw error;
      } finally {
        client.release();
      }
    },
    async markAuthorizationStatus(
      authorizationId: string,
      status: 'VOIDED' | 'CAPTURED',
      capturedMinor?: number,
    ): Promise<void> {
      await db.query(
        `UPDATE paypal_authorization
            SET status = $2, captured_minor = COALESCE($3, captured_minor), updated_at = now()
          WHERE authorization_id = $1`,
        [authorizationId, status, capturedMinor ?? null],
      );
    },
    async markCheckout(status): Promise<void> {
      await db.query(
        `UPDATE checkout SET status = $2, settled_at = now(), updated_at = now() WHERE id = $1`,
        [checkoutId, status],
      );
    },
  };
}

export function skeletonCart(): Cart {
  return {
    product_id: PRODUCT_ID,
    merchant_domain: DOMAIN,
    unit_price_minor: 24900,
    qty: 1,
    currency: 'USD',
    line_items: [],
    shipping_days: 4,
    refundable: true,
    attrs_claimed: {},
  };
}
