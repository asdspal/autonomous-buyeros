import { NextResponse } from 'next/server';
import { createSetupToken, credentialsFromEnv } from '@buyeros/core';
import { correlationId, withCorrelation } from '../../../../lib/correlation';
import { requireDemoOrService } from '../../../../lib/mandates';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(request: Request) {
  const id = correlationId(request);
  const denied = await requireDemoOrService(request);
  if (denied) return withCorrelation(denied, id);
  const body = (await request.json().catch(() => ({}))) as { customerId?: string };
  try {
    const result = await createSetupToken(credentialsFromEnv(), {
      customerId: typeof body.customerId === 'string' ? body.customerId : undefined,
    });
    return withCorrelation(
      NextResponse.json(
        {
          setupTokenId: result.setupTokenId,
          status: result.status,
          approveUrl: result.approveUrl,
        },
        { status: 201 },
      ),
      id,
    );
  } catch (error) {
    return withCorrelation(
      NextResponse.json(
        { error: { code: 'VAULT_SETUP_FAILED', detail: String(error).slice(0, 200) } },
        { status: 502 },
      ),
      id,
    );
  }
}
