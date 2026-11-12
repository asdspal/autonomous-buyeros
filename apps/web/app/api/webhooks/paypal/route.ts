import { randomUUID } from 'node:crypto';
import { NextResponse } from 'next/server';
import { canonical, parseMinor, sha256Hex, verifyWebhook } from '@buyeros/core';
import { poolInstance } from '../../../../lib/skeleton';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

interface PayPalEvent {
  id?: string;
  event_type?: string;
  resource_type?: string;
  resource?: {
    id?: string;
    amount?: { value?: string; currency_code?: string };
  };
}

export async function POST(request: Request) {
  const rawBody = await request.text();
  const webhookId = process.env.PAYPAL_WEBHOOK_ID;
  if (!webhookId) return NextResponse.json({ error: 'WEBHOOK_NOT_CONFIGURED' }, { status: 503 });

  const verified = await verifyWebhook({
    webhookId,
    rawBody,
    headers: {
      transmissionId: request.headers.get('paypal-transmission-id'),
      transmissionTime: request.headers.get('paypal-transmission-time'),
      certUrl: request.headers.get('paypal-cert-url'),
      authAlgo: request.headers.get('paypal-auth-algo'),
      transmissionSig: request.headers.get('paypal-transmission-sig'),
    },
  }).catch(() => false);
  if (!verified) return NextResponse.json({ error: 'BAD_SIGNATURE' }, { status: 400 });

  const event = JSON.parse(rawBody) as PayPalEvent;
  if (!event.id || !event.event_type) return NextResponse.json({ error: 'BAD_EVENT' }, { status: 400 });

  const db = poolInstance();
  const payloadHash = sha256Hex(canonical(event));
  const inserted = await db.query(
    `INSERT INTO webhook_event (
       id, event_type, resource_type, resource_id, transmission_id, signature_verified,
       status, payload_hash
     ) VALUES ($1,$2,$3,$4,$5,1,'RECEIVED',$6)
     ON CONFLICT (id) DO NOTHING RETURNING id`,
    [
      event.id,
      event.event_type,
      event.resource_type ?? 'unknown',
      event.resource?.id ?? 'unknown',
      request.headers.get('paypal-transmission-id'),
      payloadHash,
    ],
  );
  if (!inserted.rowCount) return NextResponse.json({ received: true, duplicate: true });

  const client = await db.connect();
  try {
    await client.query('BEGIN');
    const resourceId = event.resource?.id;
    if (resourceId && event.event_type === 'PAYMENT.AUTHORIZATION.VOIDED') {
      await client.query(
        `UPDATE paypal_authorization SET status = 'VOIDED', updated_at = now()
          WHERE authorization_id = $1`,
        [resourceId],
      );
    }
    if (resourceId && event.event_type === 'PAYMENT.AUTHORIZATION.CREATED') {
      await client.query(
        `UPDATE paypal_authorization SET status = 'AUTHORIZED', updated_at = now()
          WHERE authorization_id = $1 AND status = 'CREATED'`,
        [resourceId],
      );
    }
    if (resourceId && event.event_type === 'PAYMENT.CAPTURE.COMPLETED') {
      const captured = event.resource?.amount?.value
        ? parseMinor(event.resource.amount.value)
        : 0;
      await client.query(
        `UPDATE paypal_authorization
            SET status = 'CAPTURED', captured_minor = $2, updated_at = now()
          WHERE authorization_id = (
            SELECT authorization_id FROM paypal_authorization
             WHERE authorization_id = $1 OR order_id = $1 LIMIT 1
          )`,
        [resourceId, captured],
      );
    }
    if (resourceId && event.event_type === 'PAYMENT.CAPTURE.DENIED') {
      await client.query(
        `UPDATE checkout SET status = 'NEEDS_ATTENTION',
                attention_reason = COALESCE(attention_reason, 'PAYPAL_CAPTURE_DENIED'),
                updated_at = now()
          WHERE id IN (SELECT checkout_id FROM paypal_authorization WHERE authorization_id = $1)`,
        [resourceId],
      );
    }
    const auditPayload = { eventType: event.event_type, eventId: event.id };
    await client.query(
      `INSERT INTO audit_event (
         id, actor, actor_role, action, subject_type, subject_id, payload, payload_hash
       ) VALUES ($1,'paypal','service',$2,'webhook',$3,$4::jsonb,$5)`,
      [
        `aud_${randomUUID()}`,
        event.event_type,
        event.id,
        JSON.stringify(auditPayload),
        sha256Hex(canonical(auditPayload)),
      ],
    );
    await client.query(
      `UPDATE webhook_event SET status = 'PROCESSED', processed_at = now() WHERE id = $1`,
      [event.id],
    );
    await client.query('COMMIT');
  } catch {
    await client.query('ROLLBACK');
    await db.query(
      `UPDATE webhook_event SET status = 'FAILED', attempts = attempts + 1 WHERE id = $1`,
      [event.id],
    );
    return NextResponse.json({ error: 'PROCESSING_FAILED' }, { status: 500 });
  } finally {
    client.release();
  }

  return NextResponse.json({ received: true });
}
