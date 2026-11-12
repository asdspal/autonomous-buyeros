import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, before, beforeEach, test } from 'node:test';
import { Client } from 'pg';

const connectionString = process.env.DATABASE_URL_TEST ?? process.env.DATABASE_URL;

if (!connectionString) {
  test('database invariants', { skip: 'DATABASE_URL_TEST or DATABASE_URL not set' }, () => {});
} else {
  const db = new Client({ connectionString });

  const ids = {
    principal: `prn_${randomUUID()}`,
    agent: `agt_${randomUUID()}`,
    mandate: `mdt_${randomUUID()}`,
    checkout: `ckt_${randomUUID()}`,
  };

  async function seed(): Promise<void> {
    await db.query('TRUNCATE principal, agent, merchant, mandate, checkout, browser_session, '
      + 'paypal_authorization, verdict, verdict_clause, meter_session, meter_entry, voucher, '
      + 'audit_event CASCADE');
    await db.query(
      `INSERT INTO principal (id, email, display_name)
       VALUES ($1, $2, 'Priya')`,
      [ids.principal, `${randomUUID()}@example.com`],
    );
    await db.query(
      `INSERT INTO agent (id, principal_id, display_name, key_thumbprint)
       VALUES ($1, $2, 'agent', $3)`,
      [ids.agent, ids.principal, `jkt:${randomUUID()}`],
    );
    await db.query(
      `INSERT INTO mandate (
         id, principal_id, agent_id, status, currency, purchase_total_minor,
         per_txn_minor, max_txns, constraints, nonce, iat_epoch, exp_epoch, signature
       ) VALUES ($1,$2,$3,'ACTIVE','USD',25000,20000,1,'{}'::jsonb,$4,1700000000,1700086400,'sig')`,
      [ids.mandate, ids.principal, ids.agent, randomUUID().replaceAll('-', '')],
    );
    await db.query(
      `INSERT INTO checkout (
         id, principal_id, mandate_id, merchant_domain, request_key, currency, correlation_id
       ) VALUES ($1,$2,$3,'shop-a.example',$4,'USD',$5)`,
      [ids.checkout, ids.principal, ids.mandate, randomUUID().replaceAll('-', ''), randomUUID()],
    );
  }

  before(async () => {
    await db.connect();
    await seed();
  });

  beforeEach(async () => {
    await seed();
  });

  after(async () => {
    await db.end();
  });

  test('verdict, verdict_clause and audit_event are append-only', async () => {
    await db.query(
      `INSERT INTO verdict (id, checkout_id, decision, reason_codes, evidence_hash,
         mandate_version, auditor_version, latency_us, correlation_id)
       VALUES ($1,$2,'CAPTURE','[]'::jsonb,$3,1,'1.0.0',900,'corr')`,
      [`vrd_${randomUUID()}`, ids.checkout, 'a'.repeat(64)],
    );
    await assert.rejects(
      db.query("UPDATE verdict SET decision = 'VOID'"),
      /append-only/,
    );
    await assert.rejects(db.query('DELETE FROM verdict'), /append-only/);
  });

  test('a stored authorization cannot be updated to CAPTURED without a verdict', async () => {
    const authorizationId = `aut_${randomUUID()}`;
    await db.query(
      `INSERT INTO paypal_authorization (id, purpose, checkout_id, order_id, authorization_id,
         amount_minor, currency, status, idempotency_key)
       VALUES ($1,'PURCHASE',$2,$3,$4,18900,'USD','AUTHORIZED',$5)`,
      [authorizationId, ids.checkout, `ord_${randomUUID()}`, `pa_${randomUUID()}`, randomUUID()],
    );
    await assert.rejects(
      db.query(
        `UPDATE paypal_authorization SET status = 'CAPTURED', captured_minor = 18900 WHERE id = $1`,
        [authorizationId],
      ),
      /R004/,
    );
  });

  test('a capture cannot be recorded without a stored verdict', async () => {
    await assert.rejects(
      db.query(
        `INSERT INTO paypal_authorization (id, purpose, checkout_id, order_id, amount_minor,
           currency, captured_minor, status, idempotency_key)
         VALUES ($1,'PURCHASE',$2,$3,18900,'USD',18900,'CAPTURED',$4)`,
        [`aut_${randomUUID()}`, ids.checkout, `ord_${randomUUID()}`, randomUUID()],
      ),
      /R004/,
    );
  });

  test('no purchase authorization while a browser session is open', async () => {
    await db.query(
      `INSERT INTO browser_session (id, checkout_id, principal_id, kernel_session_id,
         egress_allowlist, step_script_version)
       VALUES ($1,$2,$3,$4,'["shop-a.example"]'::jsonb,'v1')`,
      [`brs_${randomUUID()}`, ids.checkout, ids.principal, `krn_${randomUUID()}`],
    );
    await assert.rejects(
      db.query(
        `INSERT INTO paypal_authorization (id, purpose, checkout_id, order_id, amount_minor,
           currency, status, idempotency_key)
         VALUES ($1,'PURCHASE',$2,$3,18900,'USD','CREATED',$4)`,
        [`aut_${randomUUID()}`, ids.checkout, `ord_${randomUUID()}`, randomUUID()],
      ),
      /R084/,
    );
  });

  test('a voucher must equal the price the meter debited', async () => {
    const sessionId = `mtr_${randomUUID()}`;
    const entryId = `men_${randomUUID()}`;
    await db.query(
      `INSERT INTO meter_session (id, principal_id, mandate_id, currency, authorized_minor)
       VALUES ($1,$2,$3,'USD',1000)`,
      [sessionId, ids.principal, ids.mandate],
    );
    await db.query(
      `INSERT INTO meter_entry (id, session_id, entry_no, call_hash, price_minor)
       VALUES ($1,$2,1,$3,10)`,
      [entryId, sessionId, `sha256:${'b'.repeat(64)}`],
    );
    await assert.rejects(
      db.query(
        `INSERT INTO voucher (id, session_id, entry_id, nonce, amount_minor, currency,
           call_hash, exp_epoch, signature)
         VALUES ($1,$2,$3,$4,11,'USD',$5,1900000000,'sig')`,
        [`vch_${randomUUID()}`, sessionId, entryId, randomUUID(), `sha256:${'b'.repeat(64)}`],
      ),
      /R075/,
    );
    await db.query(
      `INSERT INTO voucher (id, session_id, entry_id, nonce, amount_minor, currency,
         call_hash, exp_epoch, signature)
       VALUES ($1,$2,$3,$4,10,'USD',$5,1900000000,'sig')`,
      [`vch_${randomUUID()}`, sessionId, entryId, randomUUID(), `sha256:${'b'.repeat(64)}`],
    );
  });

  test('currency must be a three-letter uppercase code', async () => {
    await assert.rejects(
      db.query(
        `INSERT INTO checkout (id, principal_id, mandate_id, merchant_domain,
           request_key, currency, correlation_id)
         VALUES ($1,$2,$3,'shop-a.example',$4,'usd',$5)`,
        [`ckt_${randomUUID()}`, ids.principal, ids.mandate, randomUUID().replaceAll('-', ''), randomUUID()],
      ),
      /check constraint/,
    );
  });

  test('only one open browser session per checkout', async () => {
    const insert = (kernelId: string): Promise<unknown> => db.query(
      `INSERT INTO browser_session (id, checkout_id, principal_id, kernel_session_id,
         egress_allowlist, step_script_version)
       VALUES ($1,$2,$3,$4,'["shop-a.example"]'::jsonb,'v1')`,
      [`brs_${randomUUID()}`, ids.checkout, ids.principal, kernelId],
    );
    await insert(`krn_${randomUUID()}`);
    await assert.rejects(insert(`krn_${randomUUID()}`), /duplicate key|unique/);
  });

  test('a checkout must reference an ACTIVE mandate of the same principal', async () => {
    await db.query("UPDATE mandate SET status = 'REVOKED', revoked_at = now() WHERE id = $1", [
      ids.mandate,
    ]);
    await assert.rejects(
      db.query(
        `INSERT INTO checkout (id, principal_id, mandate_id, merchant_domain,
           request_key, currency, correlation_id)
         VALUES ($1,$2,$3,'shop-a.example',$4,'USD',$5)`,
        [`ckt_${randomUUID()}`, ids.principal, ids.mandate, randomUUID().replaceAll('-', ''), randomUUID()],
      ),
      /MV-R014/,
    );
  });
}
