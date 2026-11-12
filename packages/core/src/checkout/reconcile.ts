export interface HoldRow {
  authorizationId: string;
  createdAtEpoch: number;
  amountMinor: number;
  status: string;
}

export interface HoldAction {
  authorizationId: string;
  action: 'void';
  amountMinor: number;
  ageSeconds: number;
}

export function planHoldReconciliation(
  rows: HoldRow[],
  nowEpoch: number,
  maxAgeSeconds = 172_800,
): HoldAction[] {
  return rows
    .filter((row) => row.status === 'AUTHORIZED')
    .filter((row) => nowEpoch - row.createdAtEpoch >= maxAgeSeconds)
    .map((row) => ({
      authorizationId: row.authorizationId,
      action: 'void' as const,
      amountMinor: row.amountMinor,
      ageSeconds: nowEpoch - row.createdAtEpoch,
    }));
}
