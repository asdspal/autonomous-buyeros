import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, before, test } from 'node:test';
import { Client } from 'pg';
import { rateLimit } from '../../packages/core/src/checkout/ratelimit.js';

const connectionString = process.env.DATABASE_URL_TEST ?? process.env.DATABASE_URL;

if (!connectionString) {
  test('rate limit windows', { skip: 'DATABASE_URL_TEST or DATABASE_URL not set' }, () => {});
} else {
  const db = new Client({ connectionString });
  const scope = `probe-${randomUUID()}`;

  before(async () => {
    await db.connect();
  });

  after(async () => {
    await db.query('DELETE FROM rate_limit WHERE scope = $1', [scope]);
    await db.end();
  });

  test('the fixed window allows exactly the limit and then refuses with Retry-After', async () => {
    let allowed = 0;
    let refused = 0;
    let retryAfter = 0;
    for (let i = 0; i < 21; i += 1) {
      const decision = await rateLimit(db as never, scope, 'agent-a', 20);
      if (decision.allowed) allowed += 1;
      else {
        refused += 1;
        retryAfter = decision.retryAfterSeconds;
      }
    }
    assert.equal(allowed, 20);
    assert.equal(refused, 1);
    assert.ok(retryAfter >= 1 && retryAfter <= 60);
    const { rows } = await db.query(
      'SELECT count::int FROM rate_limit WHERE scope = $1 AND identity = $2',
      [scope, 'agent-a'],
    );
    assert.equal(rows[0].count, 21);
  });

  test('identities do not share a window', async () => {
    assert.equal((await rateLimit(db as never, scope, 'agent-b', 1)).allowed, true);
    assert.equal((await rateLimit(db as never, scope, 'agent-b', 1)).allowed, false);
    assert.equal((await rateLimit(db as never, scope, 'agent-c', 1)).allowed, true);
  });
}
