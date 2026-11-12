import { NextResponse } from 'next/server';
import { correlationId, withCorrelation } from '../../../lib/correlation';
import { pingDatabase } from '../../../lib/db';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(request: Request) {
  const id = correlationId(request);
  const startedAt = Date.now();
  const db = await pingDatabase(500);
  const body = {
    status: db === 'up' ? 'ok' : 'degraded',
    database: db,
    breakers: {
      paypal: 'closed',
      kernel: 'closed',
      channel3: 'closed',
      model: 'closed',
    },
    latency_ms: Date.now() - startedAt,
    correlation_id: id,
  };
  console.log(JSON.stringify({ level: 'info', msg: 'health', ...body }));
  return withCorrelation(
    NextResponse.json(body, { status: db === 'up' ? 200 : 503 }),
    id,
  );
}
