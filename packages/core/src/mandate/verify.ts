import type { MandateDraft } from './schema.js';
import { canonical } from './jcs.js';
import { isPublicP256Jwk, rfc7638Thumbprint, verifyEs256 } from '../keys.js';
import type { PublicJwk } from '../keys.js';

export type VerifyCode = 'MV-R006' | 'MV-R015';

export interface VerifyResult {
  ok: boolean;
  code?: VerifyCode;
  thumbprint?: string;
}

export async function verifyMandate(
  mandate: MandateDraft,
  signatureBase64url: string,
  jwk: unknown,
  nowEpoch: number,
): Promise<VerifyResult> {
  if (!isPublicP256Jwk(jwk)) return { ok: false, code: 'MV-R015' };
  const thumbprint = rfc7638Thumbprint(jwk);
  const valid = await verifyEs256(
    new TextEncoder().encode(canonical(mandate)),
    signatureBase64url,
    jwk as PublicJwk,
  );
  if (!valid) return { ok: false, code: 'MV-R015', thumbprint };
  if (nowEpoch >= mandate.exp) return { ok: false, code: 'MV-R006', thumbprint };
  return { ok: true, thumbprint };
}
