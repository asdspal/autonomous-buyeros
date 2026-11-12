import { NextResponse } from 'next/server';
import { clearedCookie } from '../../../../lib/auth';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST() {
  const response = NextResponse.json({ authenticated: false });
  response.headers.append('set-cookie', clearedCookie());
  return response;
}
