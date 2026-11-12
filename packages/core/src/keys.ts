import { webcrypto } from 'node:crypto';
import { importJWK } from 'jose';
import { canonical, sha256Hex } from './mandate/jcs.js';

export interface PublicJwk {
  kty: string;
  crv: string;
  x: string;
  y: string;
}

export function rfc7638Thumbprint(jwk: PublicJwk): string {
  const canonicalJwk = canonical({ crv: jwk.crv, kty: jwk.kty, x: jwk.x, y: jwk.y });
  return 'jkt:' + Buffer.from(sha256Hex(canonicalJwk), 'hex').toString('base64url');
}

export function isPublicP256Jwk(value: unknown): value is PublicJwk {
  if (!value || typeof value !== 'object') return false;
  const jwk = value as Record<string, unknown>;
  if ('d' in jwk) return false;
  return jwk.kty === 'EC' && jwk.crv === 'P-256' && typeof jwk.x === 'string' && typeof jwk.y === 'string';
}

export async function verifyEs256(
  payload: Uint8Array,
  signatureBase64url: string,
  jwk: PublicJwk,
): Promise<boolean> {
  try {
    const key = (await importJWK(jwk, 'ES256')) as webcrypto.CryptoKey;
    return await webcrypto.subtle.verify(
      { name: 'ECDSA', hash: 'SHA-256' },
      key as unknown as webcrypto.CryptoKey,
      Buffer.from(signatureBase64url, 'base64url') as unknown as NodeJS.BufferSource,
      payload as unknown as NodeJS.BufferSource,
    );
  } catch {
    return false;
  }
}
