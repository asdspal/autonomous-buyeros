import { randomUUID } from 'node:crypto';
import type { Pool } from 'pg';

export type BeginResult =
  | { state: 'new' }
  | { state: 'in_flight' }
  | { state: 'reused' }
  | { state: 'replay'; code: number; body: unknown };

export async function beginIdempotency(
  db: Pool,
  scope: string,
  key: string,
  requestHash: string,
  ttlSeconds = 86_400,
): Promise<BeginResult> {
  const inserted = await db.query(
    `INSERT INTO idempotency_record (id, scope, key, request_hash, expires_at)
     VALUES ($1,$2,$3,$4, EXTRACT(EPOCH FROM now())::bigint + $5::int)
     ON CONFLICT (scope, key) DO NOTHING
     RETURNING id`,
    [`idm_${randomUUID()}`, scope, key, requestHash, ttlSeconds],
  );
  if (inserted.rowCount) return { state: 'new' };

  const existing = await db.query<{
    request_hash: string;
    response_code: number | null;
    response_body: unknown;
  }>(
    'SELECT request_hash, response_code, response_body FROM idempotency_record WHERE scope = $1 AND key = $2',
    [scope, key],
  );
  const row = existing.rows[0];
  if (!row) return { state: 'new' };
  if (row.request_hash !== requestHash) return { state: 'reused' };
  if (row.response_code === null || row.response_body === null) return { state: 'in_flight' };
  return { state: 'replay', code: row.response_code, body: row.response_body };
}

export async function finishIdempotency(
  db: Pool,
  scope: string,
  key: string,
  code: number,
  body: unknown,
  checkoutId?: string,
): Promise<void> {
  await db.query(
    `UPDATE idempotency_record
        SET response_code = $3, response_body = $4::jsonb, checkout_id = $5
      WHERE scope = $1 AND key = $2`,
    [scope, key, code, JSON.stringify(body), checkoutId ?? null],
  );
}

export async function clearIdempotency(db: Pool, scope: string, key: string): Promise<void> {
  await db.query(
    'DELETE FROM idempotency_record WHERE scope = $1 AND key = $2 AND response_body IS NULL',
    [scope, key],
  );
}
