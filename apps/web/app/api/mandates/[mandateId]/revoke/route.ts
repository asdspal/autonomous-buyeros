import { randomUUID } from 'node:crypto';
import { NextResponse } from 'next/server';
import { canonical, sha256Hex } from '@buyeros/core';
import { correlationId, withCorrelation } from '../../../../../lib/correlation';
import { poolInstance } from '../../../../../lib/skeleton';
import { DEMO_PRINCIPAL_ID, requireDemoOrService } from '../../../../../lib/mandates';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(
  request: Request,
  context: { params: Promise<{ mandateId: string }> },
) {
  const id = correlationId(request);
  const denied = await requireDemoOrService(request);
  if (denied) return withCorrelation(denied, id);
  const { mandateId } = await context.params;
  const db = poolInstance();

  const result = await db.query(
    `UPDATE mandate SET status = 'REVOKED', revoked_at = now()
      WHERE id = $1 AND status = 'ACTIVE'`,
    [mandateId],
  );
  if (!result.rowCount) {
    const existing = await db.query('SELECT status FROM mandate WHERE id = $1', [mandateId]);
    if (!existing.rowCount) {
      return withCorrelation(
        NextResponse.json({ error: { code: 'NOT_FOUND' } }, { status: 404 }),
        id,
      );
    }
    return withCorrelation(
      NextResponse.json({ error: { code: 'MV-R014', message: 'mandate is not revocable' } }, { status: 409 }),
      id,
    );
  }

  const payload = { mandateId, revokedBy: DEMO_PRINCIPAL_ID };
  await db.query(
    `INSERT INTO audit_event (
       id, actor, actor_role, action, subject_type, subject_id, correlation_id, payload, payload_hash
     ) VALUES ($1,$2,'principal','mandate.revoked','mandate',$3,$4,$5::jsonb,$6)`,
    [
      `aud_${randomUUID()}`,
      DEMO_PRINCIPAL_ID,
      mandateId,
      id,
      JSON.stringify(payload),
      sha256Hex(canonical(payload)),
    ],
  );

  return withCorrelation(NextResponse.json({ mandateId, status: 'REVOKED' }), id);
}
