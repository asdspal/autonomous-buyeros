export interface CreateAuthorizationInput {
  amountMinor: number;
  currency: string;
  description: string;
  customId: string;
}

export interface AuthorizationRecord {
  orderId: string;
  authorizationId: string;
  status: 'CREATED' | 'AUTHORIZED' | 'CAPTURED' | 'VOIDED' | 'EXPIRED';
  amountMinor: number;
  currency: string;
}

export interface CaptureResult {
  captureId: string;
  status: string;
  amountMinor: number;
}

export interface PayPalAdapter {
  createAuthorization(input: CreateAuthorizationInput): Promise<AuthorizationRecord>;
  captureAuthorization(
    authorizationId: string,
    amountMinor: number,
    finalCapture: boolean,
  ): Promise<CaptureResult>;
  voidAuthorization(authorizationId: string): Promise<void>;
  getAuthorization(authorizationId: string): Promise<AuthorizationRecord | null>;
}

export type AdapterCall =
  | { action: 'createAuthorization'; input: CreateAuthorizationInput }
  | { action: 'captureAuthorization'; authorizationId: string; amountMinor: number; finalCapture: boolean }
  | { action: 'voidAuthorization'; authorizationId: string }
  | { action: 'getAuthorization'; authorizationId: string };

export class RecordingAdapter implements PayPalAdapter {
  readonly calls: AdapterCall[] = [];
  readonly journal: string[];

  constructor(
    private readonly authorization: AuthorizationRecord,
    journal: string[] = [],
  ) {
    this.journal = journal;
  }

  async createAuthorization(input: CreateAuthorizationInput): Promise<AuthorizationRecord> {
    this.calls.push({ action: 'createAuthorization', input });
    this.journal.push('authorize');
    return this.authorization;
  }

  async captureAuthorization(
    authorizationId: string,
    amountMinor: number,
    finalCapture: boolean,
  ): Promise<CaptureResult> {
    this.calls.push({ action: 'captureAuthorization', authorizationId, amountMinor, finalCapture });
    this.journal.push('capture');
    return { captureId: 'cap_recorded', status: 'COMPLETED', amountMinor };
  }

  async voidAuthorization(authorizationId: string): Promise<void> {
    this.calls.push({ action: 'voidAuthorization', authorizationId });
    this.journal.push('void');
  }

  async getAuthorization(authorizationId: string): Promise<AuthorizationRecord | null> {
    this.calls.push({ action: 'getAuthorization', authorizationId });
    return this.authorization;
  }
}
