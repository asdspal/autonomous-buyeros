import { GuardError } from '../types.js';
import type {
  AuthorizationRecord,
  CaptureResult,
  CreateAuthorizationInput,
  PayPalAdapter,
} from './adapter.js';

export type BreakerState = 'closed' | 'open' | 'half_open';

export class CircuitBreaker {
  private failures = 0;
  private openedAt = 0;
  constructor(
    private readonly threshold = 5,
    private readonly openMs = 30_000,
    private readonly now: () => number = Date.now,
  ) {}

  state(): BreakerState {
    if (this.failures < this.threshold) return 'closed';
    if (this.now() - this.openedAt >= this.openMs) return 'half_open';
    return 'open';
  }

  assertClosed(): void {
    if (this.state() === 'open') throw new GuardError('PAYPAL_BREAKER_OPEN');
  }

  recordSuccess(): void {
    this.failures = 0;
    this.openedAt = 0;
  }

  recordFailure(): void {
    this.failures += 1;
    if (this.failures >= this.threshold) this.openedAt = this.now();
  }
}

export function isRetryable(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  if (message.includes('PAYPAL_BREAKER_OPEN')) return false;
  const status = /PAYPAL_(\d{3})/.exec(message);
  if (status) {
    const code = Number(status[1]);
    return code === 429 || code >= 500;
  }
  return /AbortError|ETIMEDOUT|ECONNRESET|fetch failed|network/i.test(message);
}

export interface RetryOptions {
  attempts?: number;
  breaker?: CircuitBreaker;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export class RetryingPayPalAdapter implements PayPalAdapter {
  private readonly attempts: number;
  private readonly breaker: CircuitBreaker;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly now: () => number;

  constructor(
    private readonly inner: PayPalAdapter,
    options: RetryOptions = {},
  ) {
    this.attempts = options.attempts ?? 3;
    this.breaker = options.breaker ?? new CircuitBreaker();
    this.sleep = options.sleep ?? defaultSleep;
    this.now = options.now ?? Date.now;
  }

  breakerState(): BreakerState {
    return this.breaker.state();
  }

  private async withRetry<T>(operation: () => Promise<T>): Promise<T> {
    this.breaker.assertClosed();
    let lastError: unknown;
    for (let attempt = 1; attempt <= this.attempts; attempt += 1) {
      try {
        const result = await operation();
        this.breaker.recordSuccess();
        return result;
      } catch (error) {
        lastError = error;
        if (!isRetryable(error) || attempt === this.attempts) break;
        const base = 100 * 2 ** (attempt - 1);
        await this.sleep(base + Math.floor(Math.random() * 50));
      }
    }
    this.breaker.recordFailure();
    throw lastError;
  }

  createAuthorization(input: CreateAuthorizationInput): Promise<AuthorizationRecord> {
    return this.withRetry(() => this.inner.createAuthorization(input));
  }

  captureAuthorization(
    authorizationId: string,
    amountMinor: number,
    finalCapture: boolean,
    idempotencyKey?: string,
  ): Promise<CaptureResult> {
    return this.withRetry(() =>
      this.inner.captureAuthorization(authorizationId, amountMinor, finalCapture, idempotencyKey),
    );
  }

  voidAuthorization(authorizationId: string, idempotencyKey?: string): Promise<void> {
    return this.withRetry(() => this.inner.voidAuthorization(authorizationId, idempotencyKey));
  }

  getAuthorization(authorizationId: string): Promise<AuthorizationRecord | null> {
    return this.withRetry(() => this.inner.getAuthorization(authorizationId));
  }
}
