import { createHash } from 'node:crypto';

export function sha256Hex(input: string): string {
  return createHash('sha256').update(input, 'utf8').digest('hex');
}

export function canonical(value: unknown): string {
  if (value === null) return 'null';
  if (value === true) return 'true';
  if (value === false) return 'false';
  if (typeof value === 'number') {
    if (!Number.isInteger(value)) {
      throw new Error('floats are not canonicalised; money is integer minor units');
    }
    return String(value);
  }
  if (typeof value === 'string') return JSON.stringify(value);
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
  if (typeof value === 'object') {
    const rec = value as Record<string, unknown>;
    const keys = Object.keys(rec).sort();
    return '{' + keys.map((k) => JSON.stringify(k) + ':' + canonical(rec[k])).join(',') + '}';
  }
  throw new TypeError(`unsupported type for canonicalisation: ${typeof value}`);
}

export function digest(value: unknown): string {
  return 'sha256:' + sha256Hex(canonical(value));
}

export function seal<T extends object>(value: T): T & { cart_hash: string } {
  const rest: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value)) {
    if (key !== 'cart_hash') rest[key] = entry;
  }
  return { ...value, cart_hash: digest(rest) };
}
