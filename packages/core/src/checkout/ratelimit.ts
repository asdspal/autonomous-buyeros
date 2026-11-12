import type { Queryable } from './idempotency.js';

export interface RateDecision {
  allowed: boolean;
  count: number;
  limit: number;
  retryAfterSeconds: number;
}

export async function rateLimit(
  db: Queryable,
  scope: string,
  identity: string,
  limit: number,
  windowSeconds = 60,
): Promise<RateDecision> {
  const now = Math.floor(Date.now() / 1000);
  const windowStart = Math.floor(now / windowSeconds) * windowSeconds;
  const result = await db.query<{ count: number }>(
    `INSERT INTO rate_limit (scope, identity, window_start, count)
     VALUES ($1,$2,$3,1)
     ON CONFLICT (scope, identity, window_start)
     DO UPDATE SET count = LEAST(rate_limit.count + 1, 1000000)
     RETURNING count`,
    [scope, identity, windowStart],
  );
  const count = result.rows[0]?.count ?? 1;
  await db.query('DELETE FROM rate_limit WHERE window_start < $1', [windowStart - windowSeconds * 10]);
  return {
    allowed: count <= limit,
    count,
    limit,
    retryAfterSeconds: Math.max(1, windowStart + windowSeconds - now),
  };
}
