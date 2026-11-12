import type { Result } from '../types.js';

export const OPERATORS = ['eq', 'in', 'oneOf', 'gte', 'lte', 'true', 'matches'] as const;
export type Operator = (typeof OPERATORS)[number];

export function isOperator(value: string): value is Operator {
  return (OPERATORS as readonly string[]).includes(value);
}

export function evaluateOperator(op: string, observed: unknown, expected: unknown): Result {
  if (observed === null || observed === undefined) return 'UNKNOWN';

  switch (op) {
    case 'eq':
      return observed === expected ? 'PASS' : 'FAIL';
    case 'in':
    case 'oneOf':
      return Array.isArray(expected) && expected.includes(observed) ? 'PASS' : 'FAIL';
    case 'gte':
      return typeof observed === 'number' && typeof expected === 'number'
        ? observed >= expected
          ? 'PASS'
          : 'FAIL'
        : 'UNKNOWN';
    case 'lte':
      return typeof observed === 'number' && typeof expected === 'number'
        ? observed <= expected
          ? 'PASS'
          : 'FAIL'
        : 'UNKNOWN';
    case 'true':
      return observed === true ? 'PASS' : 'FAIL';
    case 'matches': {
      if (typeof observed !== 'string' || typeof expected !== 'string') return 'UNKNOWN';
      try {
        return new RegExp(expected).test(observed) ? 'PASS' : 'FAIL';
      } catch {
        return 'UNKNOWN';
      }
    }
    default:
      throw new Error(`unknown operator ${op}`);
  }
}
