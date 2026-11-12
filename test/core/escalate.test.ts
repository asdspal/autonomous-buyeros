import assert from 'node:assert/strict';
import { generateKeyPairSync, sign as cryptoSign } from 'node:crypto';
import { test } from 'node:test';
import { approvalPayload, verifyApproval } from '../../packages/core/src/auditor/escalate.js';
import { canonical } from '../../packages/core/src/mandate/jcs.js';

const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
const jwk = publicKey.export({ format: 'jwk' });

function sign(payload: unknown): string {
  return cryptoSign('sha256', Buffer.from(canonical(payload), 'utf8'), {
    key: privateKey,
    dsaEncoding: 'ieee-p1363',
  }).toString('base64url');
}

test('a signed approval verifies over the exact payload', async () => {
  const payload = approvalPayload({
    verdictId: 'vrd_x',
    decision: 'CAPTURE',
    decidedAtEpoch: 1_794_000_000,
    nonce: 'n_escalation_0001',
  });
  assert.equal(await verifyApproval(payload, sign(payload), jwk), true);
});

test('changing the decision or verdict invalidates the approval', async () => {
  const payload = approvalPayload({
    verdictId: 'vrd_x',
    decision: 'CAPTURE',
    decidedAtEpoch: 1_794_000_000,
    nonce: 'n_escalation_0001',
  });
  const signature = sign(payload);
  assert.equal(
    await verifyApproval({ ...payload, decision: 'VOID' }, signature, jwk),
    false,
  );
  assert.equal(
    await verifyApproval({ ...payload, verdictId: 'vrd_y' }, signature, jwk),
    false,
  );
});

test('a private jwk is refused', async () => {
  const payload = approvalPayload({
    verdictId: 'vrd_x',
    decision: 'VOID',
    decidedAtEpoch: 1_794_000_000,
    nonce: 'n_escalation_0001',
  });
  assert.equal(await verifyApproval(payload, sign(payload), { ...jwk, d: 'x' }), false);
});
