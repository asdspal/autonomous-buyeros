import { randomUUID } from 'node:crypto';
import { canonical, planHoldReconciliation, sha256Hex } from '@buyeros/core';
import { poolInstance } from './skeleton';
import { paypalAdapter } from './paypal';

export interface ReconcileResult {
  examined: number;
  voided: string[];
  failed: Array<{ authorizationId: string; error: string }>;
}

export async function runReconcileHolds(now = Date.now()): Promise<ReconcileResult> {
  const db = poolInstance();
  const rows = await db.query<{
    authorization_id: string;
    amount_minor: number;
    status: string;
    created_epoch: string;
  }>(
    `SELECT authorization_id, amount_minor, status,
            EXTRACT(EPOCH FROM created_at)::bigint::text AS created_epoch
       FROM paypal_authorization
      WHERE status = 'AUTHORIZED' AND authorization_id IS NOT NULL`,
  );
  const plan = planHoldReconciliation(
    rows.rows.map((row) => ({
      authorizationId: row.authorization_id,
      createdAtEpoch: Number(row.created_epoch),
      amountMinor: row.amount_minor,
      status: row.status,
    })),
    Math.floor(now / 1000),
  );

  const adapter = paypalAdapter();
  const voided: string[] = [];
  const failed: Array<{ authorizationId: string; error: string }> = [];
  for (const action of plan) {
    try {
      await adapter.voidAuthorization(action.authorizationId, `rcn_${action.authorizationId}`);
      await db.query(
        `UPDATE paypal_authorization SET status = 'VOIDED', updated_at = now()
          WHERE authorization_id = $1`,
        [action.authorizationId],
      );
      const payload = {
        authorizationId: action.authorizationId,
        ageSeconds: action.ageSeconds,
        decision: 'void',
      };
      await db.query(
        `INSERT INTO audit_event (
           id, actor, actor_role, action, subject_type, subject_id, payload, payload_hash
         ) VALUES ($1,'service','service','authorization.reconciled_void','paypal_authorization',$2,$3::jsonb,$4)`,
        [
          `aud_${randomUUID()}`,
          action.authorizationId,
          JSON.stringify(payload),
          sha256Hex(canonical(payload)),
        ],
      );
      voided.push(action.authorizationId);
    } catch (error) {
      failed.push({ authorizationId: action.authorizationId, error: String(error).slice(0, 200) });
    }
  }
  return { examined: rows.rowCount ?? 0, voided, failed };
}
