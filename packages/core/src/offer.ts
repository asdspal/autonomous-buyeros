import { createPublicKey, verify as cryptoVerify } from 'node:crypto';
import { digest } from './mandate/hash.js';
import { sha256Hex } from './mandate/jcs.js';
import { R } from './reason-codes.js';
import { GuardError } from './types.js';
import type { Clause, Result } from './types.js';

const PASS: Result = 'PASS';
const FAIL: Result = 'FAIL';

export interface MerchantPolicy {
  sku: string;
  list_price_minor: number;
  floor_price_minor: number;
  max_discount_bp: number;
  min_qty: number;
  max_qty: number;
  allow_free_shipping: boolean;
  max_rounds: number;
  policy_version: string;
}

export interface Quote {
  sku: string;
  qty: number;
  unit_price_minor: number;
  free_shipping: boolean;
  round_no: number;
  policy_version: string;
}

export interface PublicJwk {
  kty: string;
  crv: string;
  x: string;
  y: string;
}

export interface OfferDocument {
  vct: string;
  offer_id: string;
  merchant_domain: string;
  merchant_key_thumbprint: string;
  policy_version: string;
  sku: string;
  qty: number;
  unit_price_minor: number;
  shipping_minor: number;
  free_shipping: boolean;
  currency: string;
  cart_hash: string;
  nonce: string;
  iat: number;
  exp: number;
}

export function checkPolicy(policy: MerchantPolicy): void {
  if (policy.floor_price_minor > policy.list_price_minor) throw new GuardError('FLOOR_ABOVE_LIST');
  if (policy.max_discount_bp < 0 || policy.max_discount_bp > 10000) {
    throw new GuardError('BAD_DISCOUNT_BOUND');
  }
}

export function counterOffer(
  policy: MerchantPolicy,
  qty: number,
  askDiscountBp: number,
  wantsFreeShipping: boolean,
  roundNo: number,
): Quote {
  if (roundNo > policy.max_rounds) throw new GuardError('MAX_ROUNDS_EXCEEDED');
  if (qty < policy.min_qty || qty > policy.max_qty) throw new GuardError('QTY_OUT_OF_POLICY');

  const grantedBp = Math.min(Math.max(askDiscountBp, 0), policy.max_discount_bp);
  let price = Math.floor((policy.list_price_minor * (10000 - grantedBp)) / 10000);
  if (price < policy.floor_price_minor) price = policy.floor_price_minor;

  const freeShipping =
    Boolean(wantsFreeShipping) && policy.allow_free_shipping && qty >= 2;

  return {
    sku: policy.sku,
    qty,
    unit_price_minor: price,
    free_shipping: freeShipping,
    round_no: roundNo,
    policy_version: policy.policy_version,
  };
}

export function validateOffer(
  policy: MerchantPolicy,
  quote: Quote,
): { ok: boolean; code: string } {
  if (quote.policy_version !== policy.policy_version) {
    return { ok: false, code: 'POLICY_VERSION_STALE' };
  }
  if (quote.qty < policy.min_qty || quote.qty > policy.max_qty) {
    return { ok: false, code: 'QTY_OUT_OF_POLICY' };
  }
  if (quote.unit_price_minor < policy.floor_price_minor) {
    return { ok: false, code: 'BELOW_FLOOR' };
  }
  if (quote.unit_price_minor > policy.list_price_minor) {
    return { ok: false, code: 'ABOVE_LIST' };
  }
  const discountBp = Math.floor(
    ((policy.list_price_minor - quote.unit_price_minor) * 10000) / policy.list_price_minor,
  );
  if (discountBp > policy.max_discount_bp) {
    return { ok: false, code: 'DISCOUNT_EXCEEDS_POLICY' };
  }
  if (quote.free_shipping && !policy.allow_free_shipping) {
    return { ok: false, code: 'SHIPPING_NOT_CONCEDABLE' };
  }
  return { ok: true, code: 'OK' };
}

export function quoteTotalMinor(quote: Quote): number {
  return quote.qty * quote.unit_price_minor;
}

export function auditAgainstOffer(
  offerTotalMinor: number,
  checkoutTotalMinor: number,
): 'PASS' | 'MV-R021' {
  return checkoutTotalMinor === offerTotalMinor ? 'PASS' : 'MV-R021';
}

export function thumbprint(jwk: PublicJwk): string {
  return 'jkt:' + sha256Hex(JSON.stringify({ crv: jwk.crv, kty: jwk.kty, x: jwk.x, y: jwk.y }));
}

export function offerTotalMinor(offer: OfferDocument): number {
  return offer.qty * offer.unit_price_minor + offer.shipping_minor;
}

export function verifyOfferToken(token: string, jwk: PublicJwk): OfferDocument | null {
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  const [headerPart, payloadPart, signaturePart] = parts as [string, string, string];
  try {
    const header = JSON.parse(Buffer.from(headerPart, 'base64url').toString('utf8')) as {
      alg?: string;
    };
    if (header.alg !== 'ES256') return null;
    const signingInput = Buffer.from(`${headerPart}.${payloadPart}`, 'utf8');
    const signature = Buffer.from(signaturePart, 'base64url');
    const key = createPublicKey(
      { key: jwk, format: 'jwk' } as unknown as Parameters<typeof createPublicKey>[0],
    );
    const ok = cryptoVerify(
      'sha256',
      signingInput,
      { key, dsaEncoding: 'ieee-p1363' },
      signature,
    );
    if (!ok) return null;
    return JSON.parse(Buffer.from(payloadPart, 'base64url').toString('utf8')) as OfferDocument;
  } catch {
    return null;
  }
}

export interface OfferVerification {
  offer: OfferDocument;
  jwk: PublicJwk | null;
  token: string | null;
  sealedTotalMinor: number;
  nowEpoch: number;
}

export function offerClauses(input: OfferVerification): Clause[] {
  const { jwk, token, sealedTotalMinor, nowEpoch } = input;
  const verified = jwk && token ? verifyOfferToken(token, jwk) : null;
  const offer = verified ?? input.offer;
  const clauses: Clause[] = [];

  clauses.push({
    clause_id: 'C-40',
    expression: 'offer signature verifies with the registered merchant key',
    observed: verified !== null,
    source: 'merchant_key_registry',
    result: verified ? PASS : FAIL,
    code: verified ? '' : R.offer_signature,
  });

  clauses.push({
    clause_id: 'C-41',
    expression: 'offer.exp > now',
    observed: offer.exp,
    source: 'offer',
    result: offer.exp > nowEpoch ? PASS : FAIL,
    code: offer.exp > nowEpoch ? '' : R.offer_stale,
  });

  const total = offerTotalMinor(offer);
  const totalOk = total === sealedTotalMinor;
  clauses.push({
    clause_id: 'C-42',
    expression: 'qty * unit + shipping == sealed cart total',
    observed: total,
    source: 'offer:computed',
    result: totalOk ? PASS : FAIL,
    code: totalOk ? '' : R.offer_total,
  });

  const thumbOk = Boolean(
    jwk && offer.merchant_key_thumbprint === thumbprint(jwk),
  );
  clauses.push({
    clause_id: 'C-43',
    expression: 'offer.merchant_key_thumbprint == registered merchant key',
    observed: offer.merchant_key_thumbprint,
    source: 'merchant_key_registry',
    result: thumbOk ? PASS : FAIL,
    code: thumbOk ? '' : R.offer_signature,
  });

  return clauses;
}

export function offerDigest(offer: OfferDocument): string {
  return digest(offer);
}
