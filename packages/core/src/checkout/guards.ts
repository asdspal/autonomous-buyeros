import { GuardError } from '../types.js';
import type { Verdict } from '../types.js';
import type { AuthorizationRecord } from '../paypal/adapter.js';

export type AttentionReason =
  | 'PAYMENT_SOURCE_REQUIRES_ACTION'
  | 'AMOUNT_MISMATCH'
  | 'CAPTURE_WITHOUT_VERDICT'
  | 'CATALOG_UNAVAILABLE'
  | 'BROWSER_UNAVAILABLE'
  | 'MODEL_UNAVAILABLE'
  | 'PAYPAL_UNAVAILABLE';

export function assertSettlePreconditions(input: {
  verdict: Verdict | null;
  authorization: AuthorizationRecord;
  expectedTotalMinor: number;
}): void {
  if (!input.verdict) throw new GuardError('CAPTURE_WITHOUT_VERDICT');
  if (input.authorization.amountMinor !== input.expectedTotalMinor) {
    throw new GuardError('AMOUNT_MISMATCH');
  }
}

export function attentionReasonFromError(error: unknown): AttentionReason {
  const message = error instanceof Error ? error.message : String(error);
  if (/PAYER_ACTION_REQUIRED/.test(message)) return 'PAYMENT_SOURCE_REQUIRES_ACTION';
  if (/AMOUNT_MISMATCH/.test(message)) return 'AMOUNT_MISMATCH';
  if (/CAPTURE_WITHOUT_VERDICT/.test(message)) return 'CAPTURE_WITHOUT_VERDICT';
  if (/CHANNEL3|CATALOG/.test(message)) return 'CATALOG_UNAVAILABLE';
  if (/KERNEL|BROWSER/.test(message)) return 'BROWSER_UNAVAILABLE';
  if (/LLM|MODEL/.test(message)) return 'MODEL_UNAVAILABLE';
  return 'PAYPAL_UNAVAILABLE';
}
