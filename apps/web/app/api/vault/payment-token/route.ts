import { randomUUID } from 'node:crypto';
import { NextResponse } from 'next/server';
import { canonical, credentialsFromEnv, exchangeSetupToken, sha256Hex } from '@buyeros/core';
import { correlationId, withCorrelation } from '../../../../lib/correlation';
import { poolInstance } from '../../../../lib/skeleton';
import {
  DEMO_PRINCIPAL_ID,
  ensurePrincipal,
  requireDemoOrService,
} from '../../../../lib/mandates';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(request: Request) {
  const id = correlationId(request);
  const denied = await requireDemoOrService(request);
  if (denied) return withCorrelation(denied, id);
  const body = (await request.json().catch(() => ({}))) as { setupTokenId?: string };
  if (typeof body.setupTokenId !== 'string' || body.setupTokenId.length < 8) {
    return withCorrelation(
      NextResponse.json({ error: { code: 'SETUP_TOKEN_REQUIRED' } }, { status: 422 }),
      id,
    );
  }

  try {
    const result = await exchangeSetupToken(credentialsFromEnv(), body.setupTokenId);
    const db = poolInstance();
    await ensurePrincipal(db);
    await db.query(
      `UPDATE principal SET paypal_vault_id = $2, vault_status = 'ACTIVE',
              vault_updated_at = now() WHERE id = $1`,
      [DEMO_PRINCIPAL_ID, result.vaultId],
    );
    const payload = { principalId: DEMO_PRINCIPAL_ID, vaultStatus: 'ACTIVE' };
    await db.query(
      `INSERT INTO audit_event (
         id, actor, actor_role, action, subject_type, subject_id, correlation_id, payload, payload_hash
       ) VALUES ($1,$2,'principal','vault.activated','principal',$2,$3,$4::jsonb,$5)`,
      [
        `aud_${randomUUID()}`,
        DEMO_PRINCIPAL_ID,
        id,
        JSON.stringify(payload),
        sha256Hex(canonical(payload)),
      ],
    );
    return withCorrelation(NextResponse.json({ status: 'ACTIVE' }, { status: 201 }), id);
  } catch (error) {
    return withCorrelation(
      NextResponse.json(
        { error: { code: 'VAULT_EXCHANGE_FAILED', detail: String(error).slice(0, 200) } },
        { status: 502 },
      ),
      id,
    );
  }
}
