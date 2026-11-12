import { NextResponse } from 'next/server';
import { correlationId, withCorrelation } from '../../../../lib/correlation';
import { poolInstance } from '../../../../lib/skeleton';
import { loadVerdict } from '../../../../lib/verdicts';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(
  request: Request,
  context: { params: Promise<{ verdictId: string }> },
) {
  const id = correlationId(request);
  const { verdictId } = await context.params;
  const verdict = await loadVerdict(poolInstance(), verdictId);
  if (!verdict) {
    return withCorrelation(
      NextResponse.json({ error: { code: 'NOT_FOUND', message: 'no such verdict' } }, { status: 404 }),
      id,
    );
  }
  return withCorrelation(
    NextResponse.json({
      ...verdict,
      evidence_hash: verdict.evidence_hash.startsWith('sha256:')
        ? verdict.evidence_hash
        : `sha256:${verdict.evidence_hash}`,
    }),
    id,
  );
}
