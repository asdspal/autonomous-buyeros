import { accessToken, credentialsFromEnv, type PayPalCredentials } from './vault.js';

export interface WebhookHeaders {
  transmissionId?: string | null;
  transmissionTime?: string | null;
  certUrl?: string | null;
  authAlgo?: string | null;
  transmissionSig?: string | null;
}

export interface VerifyWebhookInput {
  webhookId: string;
  rawBody: string;
  headers: WebhookHeaders;
  credentials?: PayPalCredentials;
  fetchImpl?: typeof fetch;
}

export async function verifyWebhook(input: VerifyWebhookInput): Promise<boolean> {
  const { headers } = input;
  if (
    !headers.transmissionId ||
    !headers.transmissionTime ||
    !headers.certUrl ||
    !headers.authAlgo ||
    !headers.transmissionSig
  ) {
    return false;
  }
  const credentials = input.credentials ?? credentialsFromEnv();
  const fetchImpl = input.fetchImpl ?? fetch;
  const token = await accessToken({ ...credentials, fetchImpl });
  const response = await fetchImpl(
    `${credentials.baseUrl}/v1/notifications/verify-webhook-signature`,
    {
      method: 'POST',
      headers: {
        authorization: `Bearer ${token}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        transmission_id: headers.transmissionId,
        transmission_time: headers.transmissionTime,
        cert_url: headers.certUrl,
        auth_algo: headers.authAlgo,
        transmission_sig: headers.transmissionSig,
        webhook_id: input.webhookId,
        webhook_event: JSON.parse(input.rawBody),
      }),
    },
  );
  if (!response.ok) return false;
  const body = (await response.json()) as { verification_status?: string };
  return body.verification_status === 'SUCCESS';
}
