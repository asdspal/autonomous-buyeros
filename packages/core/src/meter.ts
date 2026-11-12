import { GuardError } from './types.js';

type VoucherState = 'OPEN' | 'REDEEMED' | 'EXPIRED' | 'RELEASED';

interface Voucher {
  amount: number;
  callHash: string;
  exp: number;
  state: VoucherState;
}

export interface MeterOptions {
  budgetMinor: number;
  perCallMinor: number;
  maxCalls: number;
  ttlS?: number;
}

export interface SettlePlan {
  capture_minor: number;
  final_capture: true;
  void_remainder_minor: number;
}

export class Meter {
  readonly budgetMinor: number;
  readonly perCallMinor: number;
  readonly maxCalls: number;
  readonly ttlS: number;
  clock = 0;

  private readonly vouchers = new Map<string, Voucher>();
  private debits = 0;
  private calls = 0;
  private redeemed = 0;
  private released = 0;
  private seq = 0;

  constructor(options: MeterOptions) {
    this.budgetMinor = options.budgetMinor;
    this.perCallMinor = options.perCallMinor;
    this.maxCalls = options.maxCalls;
    this.ttlS = options.ttlS ?? 60;
  }

  advance(seconds: number): void {
    this.clock += seconds;
  }

  authorize(amountMinor: number, callHash: string): string {
    if (amountMinor <= 0) throw new GuardError('VOUCHER_AMOUNT_NOT_POSITIVE');
    if (amountMinor > this.perCallMinor) throw new GuardError('PER_CALL_CAP_EXCEEDED');
    if (this.calls >= this.maxCalls) throw new GuardError('MAX_CALLS_EXCEEDED');
    if (this.debits + amountMinor > this.budgetMinor) {
      throw new GuardError('METER_BUDGET_EXCEEDED');
    }

    const nonce = `v_${String(this.seq).padStart(8, '0')}_${this.clock}`;
    this.seq += 1;
    this.vouchers.set(nonce, {
      amount: amountMinor,
      callHash,
      exp: this.clock + this.ttlS,
      state: 'OPEN',
    });
    this.debits += amountMinor;
    this.calls += 1;
    return nonce;
  }

  redeem(nonce: string, callHash: string, amountMinor: number): void {
    const voucher = this.vouchers.get(nonce);
    if (!voucher) throw new GuardError('UNKNOWN_VOUCHER');
    if (voucher.state !== 'OPEN') throw new GuardError(`VOUCHER_${voucher.state}`);
    if (this.clock > voucher.exp) throw new GuardError('VOUCHER_EXPIRED');
    if (voucher.callHash !== callHash) throw new GuardError('VOUCHER_CALL_MISMATCH');
    if (voucher.amount !== amountMinor) throw new GuardError('VOUCHER_PRICE_MISMATCH');
    voucher.state = 'REDEEMED';
    this.redeemed += voucher.amount;
  }

  expireOpen(): number {
    let releasedNow = 0;
    for (const voucher of this.vouchers.values()) {
      if (voucher.state === 'OPEN' && this.clock > voucher.exp) {
        voucher.state = 'EXPIRED';
        this.debits -= voucher.amount;
        this.released += voucher.amount;
        releasedNow += voucher.amount;
      }
    }
    return releasedNow;
  }

  get captured(): number {
    return this.redeemed;
  }

  get outstanding(): number {
    return this.debits;
  }

  get releasedTotal(): number {
    return this.released;
  }

  get callCount(): number {
    return this.calls;
  }

  settlePlan(): SettlePlan {
    if (this.redeemed > this.budgetMinor) {
      throw new GuardError('CAPTURE_EXCEEDS_AUTHORIZATION');
    }
    return {
      capture_minor: this.redeemed,
      final_capture: true,
      void_remainder_minor: this.budgetMinor - this.redeemed,
    };
  }
}
