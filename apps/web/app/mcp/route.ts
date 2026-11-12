import { NextResponse } from 'next/server';
import { agentAuth, serviceAuthorised } from '../../lib/auth';
import { poolInstance } from '../../lib/skeleton';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const mandateId = { type: 'string', pattern: '^mdt_[a-z0-9]{12,}$' } as const;

const TOOLS = [
  {
    name: 'request_checkout',
    description:
      'Ask the vault to authorize, verify and settle a cart against a signed mandate. Never captures without a stored verdict.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      required: ['mandate_id', 'request_key', 'cart'],
      properties: {
        mandate_id: mandateId,
        request_key: { type: 'string', minLength: 16, maxLength: 64 },
        cart: {
          type: 'object',
          additionalProperties: true,
          required: ['product_id', 'merchant_domain', 'unit_price_minor', 'qty', 'currency', 'cart_hash'],
          properties: {
            product_id: { type: 'string' },
            merchant_domain: { type: 'string' },
            unit_price_minor: { type: 'integer', minimum: 1 },
            qty: { type: 'integer', minimum: 1 },
            currency: { type: 'string', pattern: '^[A-Z]{3}$' },
            cart_hash: { type: 'string', pattern: '^sha256:[a-f0-9]{64}$' },
          },
        },
      },
    },
  },
  {
    name: 'get_verdict',
    description: 'Read one verdict with its clause rows.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      required: ['verdict_id'],
      properties: { verdict_id: { type: 'string' } },
    },
  },
  {
    name: 'get_mandate',
    description: 'Read status, both remaining budgets, caps, expiry and constraints for a mandate.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      required: ['mandate_id'],
      properties: { mandate_id: mandateId },
    },
  },
  {
    name: 'get_quote',
    description: 'Open or continue a negotiation, or accept the current offer. Cannot pay or widen a mandate.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      required: ['mandate_id', 'action'],
      properties: {
        mandate_id: mandateId,
        action: { enum: ['open', 'counter', 'accept'] },
        session_id: { type: 'string' },
        sku: { type: 'string' },
        qty: { type: 'integer', minimum: 1, maximum: 10 },
        ask_discount_bp: { type: 'integer', minimum: 0, maximum: 10000 },
        want_free_shipping: { type: 'boolean' },
      },
    },
  },
  {
    name: 'spend_tool_credit',
    description: 'Debit one metered credit and receive a single-use voucher. Cannot widen the allowance.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      required: ['mandate_id', 'session_id', 'call_hash', 'price_minor', 'currency'],
      properties: {
        mandate_id: mandateId,
        session_id: { type: 'string', pattern: '^mtr_[a-z0-9]{12,}$' },
        call_hash: { type: 'string', pattern: '^sha256:[a-f0-9]{64}$' },
        price_minor: { type: 'integer', minimum: 1 },
        currency: { type: 'string', pattern: '^[A-Z]{3}$' },
      },
    },
  },
];

function rpc(id: unknown, result: unknown) {
  return NextResponse.json({ jsonrpc: '2.0', id, result });
}

function rpcError(id: unknown, code: number, message: string) {
  return NextResponse.json({ jsonrpc: '2.0', id, error: { code, message } }, { status: 200 });
}

function textResult(value: unknown, isError = false) {
  return { content: [{ type: 'text', text: JSON.stringify(value) }], isError };
}

async function mandateForAgent(mandateIdValue: string, thumbprint: string) {
  const db = poolInstance();
  const result = await db.query(
    `SELECT m.*, mu.purchase_committed_minor, mu.txns_used,
            mu.meter_debited_minor, mu.meter_calls_used
       FROM mandate m LEFT JOIN mandate_usage mu ON mu.mandate_id = m.id
      WHERE m.id = $1`,
    [mandateIdValue],
  );
  if (!result.rowCount) return { error: 'MANDATE_NOT_FOUND' as const };
  const row = result.rows[0] as Record<string, unknown> & { agent_id: string };
  const agent = await db.query('SELECT key_thumbprint FROM agent WHERE id = $1', [row.agent_id]);
  if (agent.rows[0]?.key_thumbprint !== thumbprint) return { error: 'MV-R016' as const };
  return { row, db };
}

export async function POST(request: Request) {
  const raw = await request.text();
  let body: { id?: unknown; method?: string; params?: Record<string, unknown> };
  try {
    body = raw ? (JSON.parse(raw) as typeof body) : {};
  } catch {
    return rpcError(null, -32700, 'Parse error');
  }

  const db = poolInstance();
  const auth = await agentAuth(request, body, db);
  const caller =
    auth.ok && auth.agentThumbprint
      ? auth.agentThumbprint
      : serviceAuthorised(request)
        ? 'service'
        : null;
  if (!caller) return rpcError(body.id ?? null, -32001, 'UNAUTHENTICATED');

  if (body.method === 'initialize') {
    return rpc(body.id, {
      protocolVersion: '2025-06-18',
      capabilities: { tools: {} },
      serverInfo: { name: 'buyeros', version: '0.1.0' },
    });
  }
  if (body.method === 'tools/list') return rpc(body.id, { tools: TOOLS });
  if (body.method !== 'tools/call') return rpcError(body.id, -32601, 'Method not found');

  const params = body.params ?? {};
  const name = params.name as string;
  const args = (params.arguments ?? {}) as Record<string, unknown>;
  try {
    if (name === 'get_verdict') {
      const verdict = await db.query(
        `SELECT v.*, c.mandate_id FROM verdict v JOIN checkout c ON c.id = v.checkout_id
          WHERE v.id = $1`,
        [args.verdict_id],
      );
      if (!verdict.rowCount) return rpc(body.id, textResult({ error: 'NOT_FOUND' }, true));
      const clauses = await db.query(
        'SELECT clause_key, result, code, source FROM verdict_clause WHERE verdict_id = $1 ORDER BY clause_key',
        [args.verdict_id],
      );
      return rpc(body.id, textResult({ verdict: verdict.rows[0], clauses: clauses.rows }));
    }

    if (name === 'get_mandate') {
      const found = await mandateForAgent(String(args.mandate_id), caller);
      if ('error' in found) return rpc(body.id, textResult({ error: found.error }, true));
      return rpc(body.id, textResult({ mandate: found.row }));
    }

    if (name === 'request_checkout') {
      const found = await mandateForAgent(String(args.mandate_id), caller);
      if ('error' in found) return rpc(body.id, textResult({ error: found.error }, true));
      const response = await fetch(new URL('/api/checkouts', request.url), {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-service-token': process.env.SERVICE_TOKEN ?? '',
        },
        body: JSON.stringify({ requestKey: args.request_key }),
      });
      const payload = await response.json();
      return rpc(body.id, textResult(payload, !response.ok));
    }

    if (name === 'get_quote' || name === 'spend_tool_credit') {
      return rpc(
        body.id,
        textResult(
          { error: 'NOT_AVAILABLE_YET', component: name === 'get_quote' ? 'HoneyPot' : 'PayGate' },
          true,
        ),
      );
    }

    return rpcError(body.id, -32602, 'Unknown tool');
  } catch {
    return rpc(body.id, textResult({ error: 'TOOL_FAILED' }, true));
  }
}
