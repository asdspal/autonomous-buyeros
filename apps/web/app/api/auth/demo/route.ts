import { NextResponse } from 'next/server';
import { correlationId, withCorrelation } from '../../../../lib/correlation';
import { issueSessionToken, sessionCookie } from '../../../../lib/auth';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(request: Request) {
  const id = correlationId(request);
  if (process.env.DEMO_MODE !== 'on') {
    return withCorrelation(NextResponse.json({ error: 'NOT_FOUND' }, { status: 404 }), id);
  }
  const token = await issueSessionToken();
  const response = NextResponse.json({ authenticated: true }, { status: 200 });
  response.headers.append('set-cookie', sessionCookie(token));
  return withCorrelation(response, id);
}
