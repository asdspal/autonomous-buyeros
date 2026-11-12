import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, before, test } from 'node:test';
import { Client } from 'pg';
import {
  beginIdempotency,
  clearIdempotency,
  finishIdempotency,
} from '../../apps/web/lib/idempotency.js';

const connectionString = process.env.DATABASE_URL_TEST ?? process.env.DATABASE_URL;

if (!connectionString) {
  test('idempotency records', { skip: 'DATABASE_URL_TEST or DATABASE_URL not set' }, () => {});
} else {
  const db = new Client({ connectionString });
  const scope = `checkout-${randomUUID()}`;

  before(async () => {
    await db.connect();
  });

  after(async () => {
    await db.query('DELETE FROM idempotency_record WHERE scope = $1', [scope]);
    await db.end();
  });

  test('the unique (scope, key) constraint is the arbiter under concurrency', async () => {
    const key = 'race-key-000000001';
    const attempts = await Promise.all(
      Array.from({ length: 10 }, () =>
        db.query(
          `INSERT INTO idempotency_record (id, scope, key, request_hash, expires_at)
           VALUES ($1,$2,$3,$4, EXTRACT(EPOCH FROM now())::bigint + 86400)
           ON CONFLICT (scope, key) DO NOTHING RETURNING id`,
          [`idm_${randomUUID()}`, scope, key, 'a'.repeat(64)],
        ),
      ),
    );
    const winners = attempts.filter((attempt) => (attempt.rowCount ?? 0) > 0);
    assert.equal(winners.length, 1);
  });

  test('a replay returns the stored body and a reused key is refused', async () => {
    const key = 'replay-key-0000001';
    const hash = 'b'.repeat(64);
    assert.deepEqual(await beginIdempotency(db as never, scope, key, hash), { state: 'new' });
    assert.deepEqual(await beginIdempotency(db as never, scope, key, hash), { state: 'in_flight' });
    await finishIdempotency(db as never, scope, key, 200, { checkoutId: 'ckt_x', decision: 'VOID' });
    const replay = await beginIdempotency(db as never, scope, key, hash);
    assert.equal(replay.state, 'replay');
    if (replay.state === 'replay') {
      assert.equal(replay.code, 200);
      assert.deepEqual(replay.body, { checkoutId: 'ckt_x', decision: 'VOID' });
    }
    assert.deepEqual(await beginIdempotency(db as never, scope, key, 'c'.repeat(64)), {
      state: 'reused',
    });
  });

  test('a failed attempt clears its placeholder so a retry can proceed', async () => {
    const key = 'retry-key-00000001';
    const hash = 'd'.repeat(64);
    assert.deepEqual(await beginIdempotency(db as never, scope, key, hash), { state: 'new' });
    await clearIdempotency(db as never, scope, key);
    assert.deepEqual(await beginIdempotency(db as never, scope, key, hash), { state: 'new' });
  });
}
