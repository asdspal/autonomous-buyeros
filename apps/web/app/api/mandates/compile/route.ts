import { NextResponse } from 'next/server';
import { compileBrief, modelFromEnv } from '@buyeros/core';
import { correlationId, withCorrelation } from '../../../../lib/correlation';
import { requireDemoOrService } from '../../../../lib/mandates';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(request: Request) {
  const id = correlationId(request);
  const denied = requireDemoOrService(request);
  if (denied) return withCorrelation(denied, id);

  const body = (await request.json().catch(() => ({}))) as {
    brief?: unknown;
    allowedMerchants?: unknown;
    maxTotalMinor?: unknown;
  };
  if (typeof body.brief !== 'string' || body.brief.trim().length < 3) {
    return withCorrelation(
      NextResponse.json(
        { error: { code: 'MV-R017', message: 'a brief is required' } },
        { status: 422 },
      ),
      id,
    );
  }

  const context = {
    currency: process.env.ACCOUNT_CURRENCY ?? 'USD',
    issuer: 'principal:priya01',
    agentCnf: 'jkt:agentdemo0001',
    allowedMerchants:
      Array.isArray(body.allowedMerchants) && body.allowedMerchants.length
        ? (body.allowedMerchants as string[])
        : ['shop-a.example'],
    nowEpoch: Math.floor(Date.now() / 1000),
    maxTotalMinor: Number(body.maxTotalMinor ?? 500_000),
    maxMeterMinor: 5_000,
  };

  const result = await compileBrief(body.brief, context, modelFromEnv());
  if (result.status === 'refused') {
    return withCorrelation(
      NextResponse.json(
        {
          status: 'refused',
          missing: result.missing,
          error: { code: 'MV-R017', message: result.message },
          source: result.source,
        },
        { status: 422 },
      ),
      id,
    );
  }
  return withCorrelation(
    NextResponse.json({ status: 'ok', mandate: result.mandate, source: result.source }, { status: 200 }),
    id,
  );
}
