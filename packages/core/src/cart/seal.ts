import { digest } from '../mandate/hash.js';

/**
 * The hash input is every own enumerable field of the sealed object except
 * `cart_hash` itself: line items, unit prices, shipping, tax, total, currency,
 * merchant, product id and the accepted offer id when present. The auditor
 * recomputes exactly this object before comparing, so a one-minor-unit change
 * to any covered field invalidates the seal and blocks payment (R-009).
 */
export function seal<T extends object>(value: T): T & { cart_hash: string } {
  const rest: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value)) {
    if (key !== 'cart_hash') rest[key] = entry;
  }
  return { ...value, cart_hash: digest(rest) };
}
