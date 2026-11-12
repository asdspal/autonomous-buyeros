import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { test } from 'node:test';
import { evaluate } from '../../packages/core/src/auditor.js';
import { seal } from '../../packages/core/src/canonical.js';
import { buildCases } from './bench-corpus.js';

const NOW = 1_850_000_000;

test('bench: 55 cases, every decision and reason code matches the expectation', () => {
  const cases = buildCases();
  assert.equal(cases.length, 55);
  assert.equal(cases.filter((c) => c.expect === 'CAPTURE').length, 13);
  assert.equal(cases.filter((c) => c.expect !== 'CAPTURE').length, 42);

  const mismatches: string[] = [];
  for (const testCase of cases) {
    const verdict = evaluate(
      testCase.mandate,
      testCase.cart,
      testCase.catalog,
      new Set(),
      NOW,
      0,
    );
    const codeOk = testCase.expectCode
      ? verdict.reason_codes.includes(testCase.expectCode)
      : verdict.reason_codes.length === 0;
    if (verdict.decision !== testCase.expect || !codeOk) {
      mismatches.push(
        `${testCase.id} expected ${testCase.expect}/${testCase.expectCode || '-'} got ${verdict.decision}/${verdict.reason_codes.join(',') || '-'}`,
      );
    }
  }
  assert.deepEqual(mismatches, []);
});

test('auditor is deterministic: same inputs, byte-identical evidence hash', () => {
  const first = buildCases()[0]!;
  const a = evaluate(first.mandate, first.cart, first.catalog, new Set(), NOW);
  const b = evaluate(first.mandate, first.cart, first.catalog, new Set(), NOW);
  assert.equal(a.evidence_hash, b.evidence_hash);
  assert.deepEqual(a, b);
});

test('auditor matches the committed Python spike verdicts', () => {
  const path = new URL(
    '../../../memory-bank/1_blueprint/spikes/mandate_auditor/results.json',
    import.meta.url,
  );
  if (!existsSync(path)) return;
  const expected = JSON.parse(readFileSync(path, 'utf8')) as {
    cases: Array<{ id: string; got: string; codes: string[] }>;
  };
  const cases = buildCases();
  const byId = new Map(cases.map((c) => [c.id, c]));
  const drift: string[] = [];
  for (const row of expected.cases) {
    const testCase = byId.get(row.id);
    assert.ok(testCase, `missing case ${row.id}`);
    const verdict = evaluate(
      testCase.mandate,
      testCase.cart,
      testCase.catalog,
      new Set(),
      NOW,
      0,
    );
    if (verdict.decision !== row.got) drift.push(`${row.id}: ${verdict.decision} != ${row.got}`);
    if (JSON.stringify(verdict.reason_codes) !== JSON.stringify(row.codes)) {
      drift.push(`${row.id} codes: ${verdict.reason_codes} != ${row.codes}`);
    }
  }
  assert.deepEqual(drift, []);
});

test('merchant claim alone never satisfies a predicate', () => {
  const cases = buildCases();
  const testCase = cases.find((c) => c.id === 'A-M-merchant-claim');
  assert.ok(testCase);
  const verdict = evaluate(
    testCase.mandate,
    testCase.cart,
    testCase.catalog,
    new Set(),
    NOW,
  );
  const claim = verdict.clauses.find((clause) => clause.source === 'merchant_claim_untrusted');
  assert.ok(claim);
  assert.equal(claim.result, 'UNKNOWN');
});

test('unknown outside the attribute loop reaches the policy', () => {
  const first = buildCases()[0]!;
  const verdict = evaluate(
    first.mandate,
    seal({ ...first.cart, refundable: null }),
    first.catalog,
    new Set(),
    NOW,
  );
  assert.equal(verdict.decision, 'ESCALATE');
});

test('expired mandate and replayed nonce are refused', () => {
  const first = buildCases()[0]!;
  const expired = evaluate(
    { ...first.mandate, exp: 1 },
    first.cart,
    first.catalog,
    new Set(),
    NOW,
  );
  assert.equal(expired.decision, 'VOID');
  assert.ok(expired.reason_codes.includes('MV-R006'));

  const replayed = evaluate(
    first.mandate,
    first.cart,
    first.catalog,
    new Set([first.mandate.nonce]),
    NOW,
  );
  assert.equal(replayed.decision, 'VOID');
  assert.ok(replayed.reason_codes.includes('MV-R007'));
});
