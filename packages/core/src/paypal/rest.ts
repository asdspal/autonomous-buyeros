import { GuardError } from '../types.js';
import type {
  AuthorizationRecord,
  CaptureResult,
  CreateAuthorizationInput,
  PayPalAdapter,
} from './adapter.js';

export interface PayPalRestConfig {
  clientId: string;
  clientSecret: string;
  baseUrl: string;
  vaultId?: string;
}

interface TokenResponse {
  access_token: string;
  expires_in: number;
}

interface OrderResponse {
  id: string;
  status?: string;
  purchase_units?: Array<{
    payments?: { authorizations?: Array<{ id: string; status: string; amount?: { value: string; currency_code: string } }> };
  }>;
  links?: Array<{ rel: string; href: string }>;
}

export function formatMinor(amountMinor: number): string {
  if (!Number.isInteger(amountMinor) || amountMinor < 0) {
    throw new GuardError('INVALID_MINOR_AMOUNT');
  }
  return `${Math.trunc(amountMinor / 100)}.${String(amountMinor % 100).padStart(2, '0')}`;
}

export function parseMinor(value: string): number {
  const match = /^(\d+)(?:\.(\d{1,2}))?$/.exec(value);
  if (!match) throw new GuardError('UNPARSEABLE_AMOUNT');
  return Number(match[1]) * 100 + Number((match[2] ?? '0').padEnd(2, '0'));
}

export class PayPalRestAdapter implements PayPalAdapter {
  private token: { value: string; expiresAt: number } | null = null;

  constructor(private readonly config: PayPalRestConfig) {}

  private async accessToken(): Promise<string> {
    if (this.token && this.token.expiresAt > Date.now() + 30_000) return this.token.value;
    const basic = Buffer.from(`${this.config.clientId}:${this.config.clientSecret}`).toString('base64');
    const response = await fetch(`${this.config.baseUrl}/v1/oauth2/token`, {
      method: 'POST',
      headers: {
        Authorization: `Basic ${basic}`,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: 'grant_type=client_credentials',
    });
    if (!response.ok) {
      const body = await response.text();
      throw new GuardError(`PAYPAL_OAUTH_${response.status}: ${body.slice(0, 200)}`);
    }
    const data = (await response.json()) as TokenResponse;
    this.token = { value: data.access_token, expiresAt: Date.now() + data.expires_in * 1000 };
    return data.access_token;
  }

  private async call<T>(
    method: string,
    path: string,
    body?: unknown,
    requestId?: string,
  ): Promise<T> {
    const token = await this.accessToken();
    const headers: Record<string, string> = {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    };
    if (requestId) headers['PayPal-Request-Id'] = requestId;
    const response = await fetch(`${this.config.baseUrl}${path}`, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await response.text();
    const parsed = (text ? JSON.parse(text) : {}) as T;
    if (!response.ok) {
      const details = (parsed as { details?: Array<{ issue?: string }> }).details;
      const issue = details?.[0]?.issue ?? 'UNKNOWN';
      throw new GuardError(`PAYPAL_${response.status}_${issue}: ${text.slice(0, 300)}`);
    }
    return parsed;
  }

  async createAuthorization(input: CreateAuthorizationInput): Promise<AuthorizationRecord> {
    if (!this.config.vaultId) throw new GuardError('VAULT_ID_MISSING');
    const order = await this.call<OrderResponse>(
      'POST',
      '/v2/checkout/orders',
      {
        intent: 'AUTHORIZE',
        purchase_units: [
          {
            reference_id: 'buyeros-skeleton',
            custom_id: input.customId,
            amount: {
              currency_code: input.currency,
              value: formatMinor(input.amountMinor),
            },
          },
        ],
        payment_source: { paypal: { vault_id: this.config.vaultId } },
      },
      crypto.randomUUID(),
    );

    const authorization = order.purchase_units?.[0]?.payments?.authorizations?.[0];
    if (!authorization) {
      const approval = order.links?.find((link) => link.rel === 'payer-action');
      throw new GuardError(
        `PAYER_ACTION_REQUIRED${approval ? `: ${approval.href}` : ''}`,
      );
    }

    return {
      orderId: order.id,
      authorizationId: authorization.id,
      status: 'AUTHORIZED',
      amountMinor: parseMinor(authorization.amount?.value ?? formatMinor(input.amountMinor)),
      currency: authorization.amount?.currency_code ?? input.currency,
    };
  }

  async captureAuthorization(
    authorizationId: string,
    amountMinor: number,
    finalCapture: boolean,
  ): Promise<CaptureResult> {
    const capture = await this.call<{
      id?: string;
      status?: string;
      amount?: { value: string; currency_code: string };
    }>(
      'POST',
      `/v2/payments/authorizations/${authorizationId}/capture`,
      {
        amount: { currency_code: 'USD', value: formatMinor(amountMinor) },
        final_capture: finalCapture,
      },
      crypto.randomUUID(),
    );
    return {
      captureId: capture.id ?? '',
      status: capture.status ?? 'UNKNOWN',
      amountMinor: parseMinor(capture.amount?.value ?? formatMinor(amountMinor)),
    };
  }

  async voidAuthorization(authorizationId: string): Promise<void> {
    const token = await this.accessToken();
    const response = await fetch(
      `${this.config.baseUrl}/v2/payments/authorizations/${authorizationId}/void`,
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
          'PayPal-Request-Id': crypto.randomUUID(),
        },
        body: '{}',
      },
    );
    if (response.status === 204) return;
    const text = await response.text();
    if (response.status === 422 && /ALREADY_VOIDED|AUTHORIZATION_ALREADY_VOIDED/.test(text)) return;
    throw new GuardError(`PAYPAL_VOID_${response.status}: ${text.slice(0, 300)}`);
  }

  async getAuthorization(authorizationId: string): Promise<AuthorizationRecord | null> {
    const token = await this.accessToken();
    const response = await fetch(
      `${this.config.baseUrl}/v2/payments/authorizations/${authorizationId}`,
      { headers: { Authorization: `Bearer ${token}` } },
    );
    if (response.status === 404) return null;
    const body = (await response.json()) as {
      id: string;
      status: string;
      amount?: { value: string; currency_code: string };
    };
    if (!response.ok) throw new GuardError(`PAYPAL_GET_${response.status}`);
    return {
      orderId: '',
      authorizationId: body.id,
      status: body.status as AuthorizationRecord['status'],
      amountMinor: parseMinor(body.amount?.value ?? '0'),
      currency: body.amount?.currency_code ?? 'USD',
    };
  }
}
