import assert from 'node:assert/strict';
import { test } from 'node:test';
import { planHoldReconciliation } from '../../packages/core/src/checkout/reconcile.js';

const now = 2_000_000_000;

test('only AUTHORIZED holds at or past 48 hours are selected', () => {
  const plan = planHoldReconciliation(
    [
      { authorizationId: 'a-48h', createdAtEpoch: now - 172_800, amountMinor: 1, status: 'AUTHORIZED' },
      { authorizationId: 'a-49h', createdAtEpoch: now - 176_400, amountMinor: 2, status: 'AUTHORIZED' },
      { authorizationId: 'a-47h', createdAtEpoch: now - 169_200, amountMinor: 3, status: 'AUTHORIZED' },
      { authorizationId: 'a-captured', createdAtEpoch: now - 200_000, amountMinor: 4, status: 'CAPTURED' },
    ],
    now,
  );
  assert.deepEqual(plan.map((row) => row.authorizationId), ['a-48h', 'a-49h']);
  assert.ok(plan.every((row) => row.action === 'void'));
  assert.equal(plan[1]!.ageSeconds, 176_400);
});
