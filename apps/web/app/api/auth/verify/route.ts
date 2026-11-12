import { NextResponse } from 'next/server';
import { sessionCookie, verifySessionToken } from '../../../../lib/auth';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(request: Request) {
  const token = new URL(request.url).searchParams.get('token') ?? '';
  const principal = await verifySessionToken(token);
  if (!principal) {
    return NextResponse.json({ error: { code: 'INVALID_TOKEN' } }, { status: 401 });
  }
  const response = NextResponse.redirect(new URL('/cases', request.url));
  response.headers.append('set-cookie', sessionCookie(token));
  return response;
}
