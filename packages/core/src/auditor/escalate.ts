import { canonical } from '../mandate/jcs.js';
import { verifyEs256 } from '../keys.js';
import { isPublicP256Jwk } from '../keys.js';

export interface ApprovalPayload {
  verdictId: string;
  decision: 'CAPTURE' | 'VOID';
  decidedAtEpoch: number;
  nonce: string;
}

export function approvalPayload(input: ApprovalPayload): ApprovalPayload {
  return input;
}

export async function verifyApproval(
  input: ApprovalPayload,
  signatureBase64url: string,
  jwk: unknown,
): Promise<boolean> {
  if (!isPublicP256Jwk(jwk)) return false;
  return verifyEs256(
    new TextEncoder().encode(canonical(input)),
    signatureBase64url,
    jwk,
  );
}
