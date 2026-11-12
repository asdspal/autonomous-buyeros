import { NextResponse } from 'next/server';
import { correlationId, withCorrelation } from '../../../lib/correlation';
import { pingDatabase } from '../../../lib/db';
import { poolInstance } from '../../../lib/skeleton';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(request: Request) {
  const id = correlationId(request);
  const startedAt = Date.now();
  const db = await pingDatabase(500);
  let guards = 'unknown';
  if (db === 'up') {
    try {
      await poolInstance().query('SELECT assert_money_guards()');
      guards = 'ok';
    } catch {
      guards = 'missing';
    }
  }
  const body = {
    status: db === 'up' ? 'ok' : 'degraded',
    database: db,
    money_guards: guards,
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
    NextResponse.json(body, { status: db === 'up' && guards !== 'missing' ? 200 : 503 }),
    id,
  );
}
