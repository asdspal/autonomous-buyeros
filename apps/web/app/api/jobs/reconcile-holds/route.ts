import { NextResponse } from 'next/server';
import { serviceAuthorised } from '../../../../lib/auth';
import { runReconcileHolds } from '../../../../lib/jobs';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(request: Request) {
  if (!serviceAuthorised(request)) {
    return NextResponse.json({ error: 'UNAUTHENTICATED' }, { status: 401 });
  }
  const result = await runReconcileHolds();
  return NextResponse.json(result, { status: result.failed.length ? 207 : 200 });
}
