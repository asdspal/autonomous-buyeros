import { NextResponse } from 'next/server';
import { correlationId, withCorrelation } from '../../../../lib/correlation';
import { issueSessionToken } from '../../../../lib/auth';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(request: Request) {
  const id = correlationId(request);
  const body = (await request.json().catch(() => ({}))) as { email?: string };
  if (typeof body.email !== 'string' || !body.email.includes('@')) {
    return withCorrelation(
      NextResponse.json({ error: { code: 'INVALID_EMAIL' } }, { status: 422 }),
      id,
    );
  }
  const token = await issueSessionToken();
  const link = new URL(`/api/auth/verify?token=${encodeURIComponent(token)}`, request.url).toString();
  if (process.env.DEMO_MODE === 'on') {
    return withCorrelation(NextResponse.json({ sent: true, link }, { status: 200 }), id);
  }
  return withCorrelation(NextResponse.json({ sent: true }, { status: 200 }), id);
}
