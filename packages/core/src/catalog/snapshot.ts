import { digest } from '../mandate/hash.js';
import type { Channel3Product } from './channel3.js';

export interface SnapshotAttributes {
  material: string | null;
  returnWindowDays: number | null;
  washable: boolean | null;
}

export interface CatalogSnapshot {
  productId: string;
  merchant: string;
  priceMinor: number;
  currency: string;
  attributes: SnapshotAttributes;
  raw: {
    price: number;
    materials: string[];
    structuredAttributes: Record<string, string[]>;
    keyFeatures: string[];
  };
  source: 'live' | 'cache' | 'fixture';
  fetchedAt: string;
  recordHash: string;
}

function asArray(value: string[] | string | undefined): string[] {
  if (value === undefined) return [];
  return Array.isArray(value) ? [...value] : [value];
}

function attributeMap(product: Channel3Product): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  for (const [key, value] of Object.entries(product.structured_attributes ?? {})) {
    out[key] = asArray(value).sort();
  }
  return out;
}

function detectMaterial(product: Channel3Product): string | null {
  const rugMaterial = asArray(product.structured_attributes?.['rug-material'])[0];
  const material = rugMaterial ?? product.materials?.[0];
  return material ? material.trim().toLowerCase() : null;
}

function detectWashable(product: Channel3Product): boolean | null {
  const care = [
    ...asArray(product.structured_attributes?.['care-instructions']),
    ...(product.key_features ?? []),
  ].join(' ');
  if (!care) return null;
  if (/machine[ -]?wash/i.test(care)) return true;
  if (/hand[ -]?wash|dry[ -]?clean/i.test(care) && !/machine/i.test(care)) return false;
  return null;
}

function detectReturnWindowDays(product: Channel3Product): number | null {
  const text = `${product.title} ${product.description ?? ''}`;
  const match = /(\d{1,3})[ -]day\s+(?:free\s+)?returns?/i.exec(text);
  return match ? Number(match[1]) : null;
}

export function toSnapshot(
  product: Channel3Product,
  options: { source: 'live' | 'cache' | 'fixture'; fetchedAt: string },
): CatalogSnapshot {
  const offer = product.offers?.[0];
  if (!offer) throw new Error('CATALOG_OFFER_MISSING');
  const priceMinor = Math.round(offer.price.price * 100);
  if (!Number.isInteger(priceMinor) || priceMinor < 0) throw new Error('CATALOG_PRICE_INVALID');

  const attributes: SnapshotAttributes = {
    material: detectMaterial(product),
    returnWindowDays: detectReturnWindowDays(product),
    washable: detectWashable(product),
  };
  const raw = {
    price: offer.price.price,
    materials: [...(product.materials ?? [])].sort(),
    structuredAttributes: attributeMap(product),
    keyFeatures: [...(product.key_features ?? [])].sort(),
  };
  const hashed = {
    productId: product.id,
    merchant: offer.domain,
    priceMinor,
    currency: offer.price.currency,
    attributes,
    source: options.source,
  };
  return {
    ...hashed,
    raw,
    fetchedAt: options.fetchedAt,
    recordHash: digest(hashed),
  };
}
