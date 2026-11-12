import { NextResponse } from 'next/server';
import { parseMandate, verifyMandate } from '@buyeros/core';
import { correlationId, withCorrelation } from '../../../lib/correlation';
import { poolInstance } from '../../../lib/skeleton';
import {
  ensurePrincipal,
  registerAgent,
  requireDemoOrService,
  storeMandate,
} from '../../../lib/mandates';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(request: Request) {
  const id = correlationId(request);
  const denied = await requireDemoOrService(request);
  if (denied) return withCorrelation(denied, id);

  const body = (await request.json().catch(() => ({}))) as {
    mandate?: unknown;
    signature?: unknown;
    publicJwk?: unknown;
    previousMandateId?: unknown;
  };

  const parsed = parseMandate(body.mandate);
  if (!parsed.ok) {
    return withCorrelation(
      NextResponse.json(
        { error: { code: 'MV-R017', message: 'mandate schema violation', details: parsed.issues } },
        { status: 422 },
      ),
      id,
    );
  }
  if (typeof body.signature !== 'string') {
    return withCorrelation(
      NextResponse.json(
        { error: { code: 'MV-R015', message: 'signature missing' } },
        { status: 422 },
      ),
      id,
    );
  }

  const verified = await verifyMandate(
    parsed.mandate,
    body.signature,
    body.publicJwk,
    Math.floor(Date.now() / 1000),
  );
  if (!verified.ok) {
    return withCorrelation(
      NextResponse.json(
        {
          error: {
            code: verified.code,
            message: verified.code === 'MV-R006' ? 'mandate expired' : 'signature verification failed',
          },
        },
        { status: verified.code === 'MV-R006' ? 409 : 422 },
      ),
      id,
    );
  }

  const db = poolInstance();
  try {
    await ensurePrincipal(db);
    const agentId = await registerAgent(db, parsed.mandate.agent_cnf);
    const stored = await storeMandate(db, {
      mandate: parsed.mandate,
      signature: body.signature,
      jwk: body.publicJwk,
      principalKeyThumbprint: verified.thumbprint!,
      agentId,
      previousMandateId:
        typeof body.previousMandateId === 'string' ? body.previousMandateId : undefined,
    });
    return withCorrelation(
      NextResponse.json(
        { ...stored, status: 'ACTIVE', agent_cnf: parsed.mandate.agent_cnf },
        { status: 201 },
      ),
      id,
    );
  } catch (error) {
    const code = (error as { code?: string }).code;
    if (code === 'PREV_NOT_FOUND') {
      return withCorrelation(
        NextResponse.json({ error: { code: 'NOT_FOUND', message: 'previous mandate not found' } }, { status: 404 }),
        id,
      );
    }
    if (code === '23505') {
      return withCorrelation(
        NextResponse.json(
          { error: { code: 'MV-R007', message: 'mandate nonce already consumed' } },
          { status: 409 },
        ),
        id,
      );
    }
    console.error(JSON.stringify({ level: 'error', msg: 'mandate.store_failed', correlation_id: id, error: String(error) }));
    return withCorrelation(
      NextResponse.json(
        { error: { code: 'MV-R015', message: 'mandate could not be stored' } },
        { status: 500 },
      ),
      id,
    );
  }
}
