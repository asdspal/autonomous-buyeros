import { NextResponse, type NextRequest } from 'next/server';

export function middleware(request: NextRequest) {
  const method = request.method.toUpperCase();
  if (!['POST', 'PUT', 'PATCH', 'DELETE'].includes(method)) return NextResponse.next();
  if (request.nextUrl.pathname.startsWith('/api/webhooks/')) return NextResponse.next();

  const origin = request.headers.get('origin');
  if (!origin) return NextResponse.next();
  const allowed = new Set<string>([request.nextUrl.origin]);
  if (process.env.APP_ORIGIN) allowed.add(process.env.APP_ORIGIN);
  if (!allowed.has(origin)) {
    return NextResponse.json(
      { error: { code: 'ORIGIN_REFUSED', message: 'cross-origin mutation refused' } },
      { status: 403 },
    );
  }
  return NextResponse.next();
}

export const config = { matcher: ['/api/:path*', '/mcp'] };
