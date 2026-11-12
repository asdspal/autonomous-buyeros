import { randomUUID } from 'node:crypto';
import { NextResponse } from 'next/server';
import {
  approvalPayload,
  canonical,
  rfc7638Thumbprint,
  sha256Hex,
  verifyApproval,
} from '@buyeros/core';
import { correlationId, withCorrelation } from '../../../../../lib/correlation';
import { sessionPrincipal, serviceAuthorised } from '../../../../../lib/auth';
import { paypalAdapter } from '../../../../../lib/paypal';
import { poolInstance } from '../../../../../lib/skeleton';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(
  request: Request,
  context: { params: Promise<{ verdictId: string }> },
) {
  const id = correlationId(request);
  if (!serviceAuthorised(request) && !(await sessionPrincipal(request))) {
    return withCorrelation(NextResponse.json({ error: 'UNAUTHENTICATED' }, { status: 401 }), id);
  }
  const { verdictId } = await context.params;
  const body = (await request.json().catch(() => ({}))) as {
    action?: 'approve' | 'decline';
    signature?: string;
    publicJwk?: unknown;
    nonce?: string;
  };
  if (body.action !== 'approve' && body.action !== 'decline') {
    return withCorrelation(NextResponse.json({ error: 'ACTION_REQUIRED' }, { status: 422 }), id);
  }
  if (typeof body.signature !== 'string' || typeof body.nonce !== 'string' || body.nonce.length < 8) {
    return withCorrelation(NextResponse.json({ error: 'SIGNATURE_REQUIRED' }, { status: 422 }), id);
  }

  const db = poolInstance();
  const verdict = await db.query(
    'SELECT id, checkout_id, decision FROM verdict WHERE id = $1',
    [verdictId],
  );
  if (!verdict.rowCount) {
    return withCorrelation(NextResponse.json({ error: 'NOT_FOUND' }, { status: 404 }), id);
  }
  const row = verdict.rows[0] as { id: string; checkout_id: string; decision: string };
  if (row.decision !== 'ESCALATE') {
    return withCorrelation(
      NextResponse.json({ error: { code: 'NOT_ESCALATED' } }, { status: 409 }),
      id,
    );
  }
  const decided = await db.query(
    "SELECT id FROM escalation WHERE verdict_id = $1 AND status <> 'OPEN'",
    [verdictId],
  );
  if (decided.rowCount) {
    return withCorrelation(
      NextResponse.json({ error: { code: 'ALREADY_DECIDED' } }, { status: 409 }),
      id,
    );
  }

  const decision = body.action === 'approve' ? 'CAPTURE' : 'VOID';
  const payload = approvalPayload({
    verdictId,
    decision,
    decidedAtEpoch: Math.floor(Date.now() / 1000),
    nonce: body.nonce,
  });
  const validSignature = await verifyApproval(payload, body.signature, body.publicJwk);
  if (!validSignature) {
    return withCorrelation(
      NextResponse.json({ error: { code: 'MV-R015' } }, { status: 422 }),
      id,
    );
  }

  const thumbprint = rfc7638Thumbprint(body.publicJwk as never);
  const key = await db.query(
    'SELECT id FROM principal_key WHERE thumbprint = $1',
    [thumbprint],
  );
  if (!key.rowCount) {
    return withCorrelation(
      NextResponse.json({ error: { code: 'MV-R016', message: 'unknown principal key' } }, { status: 403 }),
      id,
    );
  }
  const keyId = (key.rows[0] as { id: string }).id;

  const authorization = await db.query(
    `SELECT authorization_id, amount_minor, currency FROM paypal_authorization
      WHERE checkout_id = $1 AND purpose = 'PURCHASE' ORDER BY created_at DESC LIMIT 1`,
    [row.checkout_id],
  );
  if (!authorization.rowCount) {
    return withCorrelation(
      NextResponse.json({ error: { code: 'NO_AUTHORIZATION' } }, { status: 409 }),
      id,
    );
  }
  const auth = authorization.rows[0] as {
    authorization_id: string;
    amount_minor: number;
    currency: string;
  };

  const escalationId = `esc_${randomUUID()}`;
  const adapter = paypalAdapter();
  const moneyKey = `esc_${escalationId}`;
  try {
    if (decision === 'CAPTURE') {
      await adapter.captureAuthorization(auth.authorization_id, auth.amount_minor, true, moneyKey);
    } else {
      await adapter.voidAuthorization(auth.authorization_id, moneyKey);
    }
  } catch (error) {
    return withCorrelation(
      NextResponse.json(
        { error: { code: 'PAYPAL_FAILED', detail: String(error).slice(0, 200) } },
        { status: 502 },
      ),
      id,
    );
  }

  const client = await db.connect();
  try {
    await client.query('BEGIN');
    await client.query(
      `INSERT INTO escalation (
         id, verdict_id, status, expires_at, approval_signature, approved_by_key_id,
         decline_reason, decided_at
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,now())`,
      [
        escalationId,
        verdictId,
        decision === 'CAPTURE' ? 'APPROVED' : 'DECLINED',
        Math.floor(Date.now() / 1000) + 172_800,
        body.signature,
        keyId,
        decision === 'VOID' ? 'declined by principal' : null,
      ],
    );
    await client.query(
      `UPDATE paypal_authorization SET status = $2, captured_minor = $3, updated_at = now()
        WHERE authorization_id = $1`,
      [auth.authorization_id, decision === 'CAPTURE' ? 'CAPTURED' : 'VOIDED', decision === 'CAPTURE' ? auth.amount_minor : 0],
    );
    await client.query(
      `UPDATE checkout SET status = 'SETTLED', settled_at = now(), updated_at = now() WHERE id = $1`,
      [row.checkout_id],
    );
    const auditPayload = { escalationId, verdictId, decision, nonce: body.nonce };
    await client.query(
      `INSERT INTO audit_event (
         id, actor, actor_role, action, subject_type, subject_id, correlation_id, payload, payload_hash
       ) VALUES ($1,'prn_demo','principal','escalation.resolved','verdict',$2,$3,$4::jsonb,$5)`,
      [
        `aud_${randomUUID()}`,
        verdictId,
        id,
        JSON.stringify(auditPayload),
        sha256Hex(canonical(auditPayload)),
      ],
    );
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }

  return withCorrelation(
    NextResponse.json({ verdictId, escalationId, decision, status: decision === 'CAPTURE' ? 'APPROVED' : 'DECLINED' }),
    id,
  );
}
