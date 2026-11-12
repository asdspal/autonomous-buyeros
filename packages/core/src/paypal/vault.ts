import { GuardError } from '../types.js';

export interface PayPalCredentials {
  clientId: string;
  clientSecret: string;
  baseUrl: string;
  fetchImpl?: typeof fetch;
}

export interface SetupTokenResult {
  setupTokenId: string;
  status: string;
  approveUrl: string;
}

export interface PaymentTokenResult {
  vaultId: string;
  payerId?: string;
}

export async function accessToken(credentials: PayPalCredentials): Promise<string> {
  const fetchImpl = credentials.fetchImpl ?? fetch;
  const basic = Buffer.from(`${credentials.clientId}:${credentials.clientSecret}`).toString('base64');
  const response = await fetchImpl(`${credentials.baseUrl}/v1/oauth2/token`, {
    method: 'POST',
    headers: {
      authorization: `Basic ${basic}`,
      'content-type': 'application/x-www-form-urlencoded',
    },
    body: 'grant_type=client_credentials',
  });
  if (!response.ok) throw new GuardError(`PAYPAL_OAUTH_${response.status}`);
  const body = (await response.json()) as { access_token: string };
  return body.access_token;
}

async function call<T>(
  credentials: PayPalCredentials,
  token: string,
  method: string,
  path: string,
  body: unknown,
): Promise<T> {
  const fetchImpl = credentials.fetchImpl ?? fetch;
  const response = await fetchImpl(`${credentials.baseUrl}${path}`, {
    method,
    headers: {
      authorization: `Bearer ${token}`,
      'content-type': 'application/json',
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  const parsed = (text ? JSON.parse(text) : {}) as T & { details?: Array<{ issue?: string }> };
  if (!response.ok) {
    const issue = parsed.details?.[0]?.issue ?? 'UNKNOWN';
    throw new GuardError(`PAYPAL_${response.status}_${issue}: ${text.slice(0, 200)}`);
  }
  return parsed;
}

export async function createSetupToken(
  credentials: PayPalCredentials,
  options: { customerId?: string; returnUrl?: string; cancelUrl?: string } = {},
): Promise<SetupTokenResult> {
  const token = await accessToken(credentials);
  const result = await call<{
    id: string;
    status: string;
    links?: Array<{ rel: string; href: string }>;
  }>(credentials, token, 'POST', '/v3/vault/setup-tokens', {
    payment_source: {
      paypal: {
        description: 'BuyerOS sandbox wallet',
        permit_multiple_payment_tokens: false,
        usage_pattern: 'IMMEDIATE',
        usage_type: 'MERCHANT',
        customer_type: 'CONSUMER',
        ...(options.customerId ? { customer: { id: options.customerId } } : {}),
        experience_context: {
          shipping_preference: 'NO_SHIPPING',
          payment_method_preference: 'IMMEDIATE_PAYMENT_REQUIRED',
          brand_name: 'BuyerOS',
          locale: 'en-US',
          return_url: options.returnUrl ?? 'https://example.com/vault/return',
          cancel_url: options.cancelUrl ?? 'https://example.com/vault/cancel',
        },
      },
    },
  });
  const approveUrl = result.links?.find((link) => link.rel === 'approve')?.href;
  if (!approveUrl) throw new GuardError('PAYPAL_NO_APPROVE_LINK');
  return { setupTokenId: result.id, status: result.status, approveUrl };
}

export async function exchangeSetupToken(
  credentials: PayPalCredentials,
  setupTokenId: string,
): Promise<PaymentTokenResult> {
  const token = await accessToken(credentials);
  const result = await call<{
    id: string;
    payment_source?: { paypal?: { payer_id?: string } };
  }>(credentials, token, 'POST', '/v3/vault/payment-tokens', {
    payment_source: { token: { id: setupTokenId, type: 'SETUP_TOKEN' } },
  });
  if (!result.id) throw new GuardError('PAYPAL_NO_PAYMENT_TOKEN');
  return { vaultId: result.id, payerId: result.payment_source?.paypal?.payer_id };
}

export function credentialsFromEnv(): PayPalCredentials {
  const clientId = process.env.PAYPAL_CLIENT_ID;
  const clientSecret = process.env.PAYPAL_CLIENT_SECRET;
  const baseUrl = process.env.PAYPAL_API_BASE;
  if (!clientId || !clientSecret || !baseUrl) {
    throw new GuardError('PAYPAL_CONFIG_MISSING');
  }
  return { clientId, clientSecret, baseUrl };
}
