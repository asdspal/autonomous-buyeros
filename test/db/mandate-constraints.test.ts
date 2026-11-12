import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, before, test } from 'node:test';
import { Client } from 'pg';

const connectionString = process.env.DATABASE_URL_TEST ?? process.env.DATABASE_URL;

if (!connectionString) {
  test('mandate constraints', { skip: 'DATABASE_URL_TEST or DATABASE_URL not set' }, () => {});
} else {
  const db = new Client({ connectionString });
  const principal = `prn_${randomUUID()}`;
  const agent = `agt_${randomUUID()}`;

  async function mandateRow(id: string, nonce: string, totalMinor: number): Promise<unknown> {
    return db.query(
      `INSERT INTO mandate (
         id, principal_id, agent_id, status, currency, purchase_total_minor,
         per_txn_minor, max_txns, constraints, nonce, iat_epoch, exp_epoch, signature
       ) VALUES ($1,$2,$3,'ACTIVE','USD',$4,20000,1,'{}'::jsonb,$5,1793000000,1795592000,'sig')`,
      [id, principal, agent, totalMinor, nonce],
    );
  }

  before(async () => {
    await db.connect();
    await db.query(
      `INSERT INTO principal (id, email, display_name) VALUES ($1,$2,'Priya')`,
      [principal, `${randomUUID()}@example.com`],
    );
    await db.query(
      `INSERT INTO agent (id, principal_id, display_name, key_thumbprint) VALUES ($1,$2,'a',$3)`,
      [agent, principal, `jkt:${randomUUID()}`],
    );
  });

  after(async () => {
    await db.query('DELETE FROM mandate WHERE principal_id = $1', [principal]);
    await db.query('DELETE FROM agent WHERE id = $1', [agent]);
    await db.query('DELETE FROM principal WHERE id = $1', [principal]);
    await db.end();
  });

  test('the database refuses a budget above the schema ceiling', async () => {
    await assert.rejects(
      mandateRow(`mdt_${randomUUID().slice(0, 12)}`, randomUUID().replaceAll('-', ''), 5_000_001),
      /check constraint/,
    );
  });

  test('the database refuses a lifetime above 30 days', async () => {
    await assert.rejects(
      db.query(
        `INSERT INTO mandate (
           id, principal_id, agent_id, status, currency, purchase_total_minor,
           per_txn_minor, max_txns, constraints, nonce, iat_epoch, exp_epoch, signature
         ) VALUES ($1,$2,$3,'ACTIVE','USD',25000,20000,1,'{}'::jsonb,$4,1793000000,1798000000,'sig')`,
        [`mdt_${randomUUID().slice(0, 12)}`, principal, agent, randomUUID().replaceAll('-', '')],
      ),
      /check constraint/,
    );
  });

  test('one nonce cannot be registered twice for a principal (MV-R007)', async () => {
    const nonce = randomUUID().replaceAll('-', '');
    await mandateRow(`mdt_${randomUUID().slice(0, 12)}`, nonce, 25000);
    await assert.rejects(
      mandateRow(`mdt_${randomUUID().slice(0, 12)}`, nonce, 25000),
      /duplicate key|unique/,
    );
  });

  test('a valid mandate inserts and its usage row starts at zero', async () => {
    const id = `mdt_${randomUUID().slice(0, 12)}`;
    await mandateRow(id, randomUUID().replaceAll('-', ''), 25000);
    await db.query('INSERT INTO mandate_usage (mandate_id) VALUES ($1)', [id]);
    const { rows } = await db.query(
      `SELECT purchase_committed_minor, txns_used, meter_debited_minor, meter_calls_used
         FROM mandate_usage WHERE mandate_id = $1`,
      [id],
    );
    assert.deepEqual(rows[0], {
      purchase_committed_minor: 0,
      txns_used: 0,
      meter_debited_minor: 0,
      meter_calls_used: 0,
    });
  });
}
