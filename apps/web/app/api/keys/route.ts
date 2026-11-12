import { NextResponse } from 'next/server';
import { isPublicP256Jwk, rfc7638Thumbprint } from '@buyeros/core';
import { correlationId, withCorrelation } from '../../../lib/correlation';
import { poolInstance } from '../../../lib/skeleton';
import { ensurePrincipal, registerPrincipalKey, requireDemoOrService } from '../../../lib/mandates';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(request: Request) {
  const id = correlationId(request);
  const denied = await requireDemoOrService(request);
  if (denied) return withCorrelation(denied, id);

  const body = (await request.json().catch(() => ({}))) as { jwk?: unknown };
  if (!isPublicP256Jwk(body.jwk)) {
    return withCorrelation(
      NextResponse.json(
        { error: 'INVALID_JWK', message: 'a public P-256 JWK without d is required' },
        { status: 422 },
      ),
      id,
    );
  }

  const db = poolInstance();
  await ensurePrincipal(db);
  const thumbprint = rfc7638Thumbprint(body.jwk);
  await registerPrincipalKey(db, body.jwk, thumbprint);

  return withCorrelation(
    NextResponse.json({ thumbprint, alg: 'ES256' }, { status: 201 }),
    id,
  );
}
