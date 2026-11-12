import assert from 'node:assert/strict';
import path from 'node:path';
import { test } from 'node:test';
import { loadCases, runBench } from '../../packages/bench/run.js';

test('MandateBench: 55 cases, exact verdict and reason code, p95 within budget', () => {
  const cases = loadCases(path.resolve('packages/bench/cases'));
  assert.equal(cases.length, 55);
  assert.equal(cases.filter((c) => c.expect === 'CAPTURE').length, 13);
  assert.equal(cases.filter((c) => c.expect !== 'CAPTURE').length, 42);

  const result = runBench(cases, 50);
  assert.deepEqual(result.failures, []);
  assert.equal(result.accuracy, 1);
  assert.equal(result.reasonCodeAccuracy, 1);
  assert.ok(
    result.p95Ms <= result.budgetMs,
    `p95 ${result.p95Ms}ms over budget ${result.budgetMs}ms`,
  );
  assert.deepEqual(result.provenance, { live: 0, synthetic: 55 });
});
