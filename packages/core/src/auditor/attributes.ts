import type { Cart, Catalog } from '../types.js';

export const ATTRIBUTE_SOURCES = [
  'catalog',
  'merchant_claim_untrusted',
  'absent',
  'offer:accepted',
  'mandate',
  'cart',
  'cart:computed',
  'vault',
  'offer',
  'offer:computed',
  'merchant_key_registry',
] as const;

export type AttributeSource = (typeof ATTRIBUTE_SOURCES)[number];

export interface ResolvedAttribute {
  observed: unknown;
  source: AttributeSource;
}

export function resolveAttribute(
  cart: Cart,
  catalog: Catalog | null,
  name: string,
): ResolvedAttribute {
  const attrs = (catalog?.attrs ?? {}) as Record<string, unknown>;
  if (name in attrs) return { observed: attrs[name], source: 'catalog' };
  const claimed = cart.attrs_claimed ?? {};
  if (name in claimed) return { observed: null, source: 'merchant_claim_untrusted' };
  return { observed: null, source: 'absent' };
}
