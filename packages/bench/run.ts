import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { evaluate } from '../../packages/core/src/auditor.js';
import type { Cart, Catalog, Mandate } from '../../packages/core/src/types.js';
import { buildCases } from './corpus.js';

export interface BenchCase {
  id: string;
  class: string;
  mandate: Mandate;
  cart: Cart;
  catalog: Catalog | null;
  expect: string;
  expectCode: string;
  note: string;
  provenance: string;
}

export interface BenchResult {
  runAt: string;
  commit: string;
  cases: number;
  passed: number;
  accuracy: number;
  reasonCodeAccuracy: number;
  p95Ms: number;
  budgetMs: number;
  provenance: { live: number; synthetic: number };
  failures: string[];
}

const NOW = 1_850_000_000;

export function loadCases(dir: string): BenchCase[] {
  return readdirSync(dir)
    .filter((file) => file.endsWith('.json'))
    .sort()
    .map((file) => JSON.parse(readFileSync(path.join(dir, file), 'utf8')) as BenchCase);
}

export function runBench(cases: BenchCase[], iterations = 200): BenchResult {
  const budgetMs = Number(process.env.BENCH_MAX_P95_MS ?? 50);
  const timings: number[] = [];
  const failures: string[] = [];
  let passed = 0;
  let codesOk = 0;

  for (const testCase of cases) {
    const verdict = evaluate(
      testCase.mandate,
      testCase.cart,
      testCase.catalog,
      new Set(),
      NOW,
      0,
    );
    const decisionOk = verdict.decision === testCase.expect;
    const codeOk = testCase.expectCode
      ? verdict.reason_codes.includes(testCase.expectCode)
      : verdict.reason_codes.length === 0;
    if (decisionOk) passed += 1;
    if (codeOk) codesOk += 1;
    if (!decisionOk || !codeOk) {
      failures.push(
        `${testCase.id}: expected ${testCase.expect}/${testCase.expectCode || '-'} got ${verdict.decision}/${verdict.reason_codes.join(',') || '-'}`,
      );
    }
    for (let i = 0; i < iterations; i += 1) {
      const started = process.hrtime.bigint();
      evaluate(testCase.mandate, testCase.cart, testCase.catalog, new Set(), NOW, 0);
      timings.push(Number(process.hrtime.bigint() - started) / 1e6);
    }
  }

  timings.sort((a, b) => a - b);
  const p95Ms = Number((timings[Math.min(timings.length - 1, Math.floor(timings.length * 0.95))] ?? 0).toFixed(4));
  const live = cases.filter((testCase) => testCase.provenance === 'live').length;
  return {
    runAt: new Date().toISOString(),
    commit: process.env.GIT_COMMIT ?? 'local',
    cases: cases.length,
    passed,
    accuracy: Number((passed / cases.length).toFixed(4)),
    reasonCodeAccuracy: Number((codesOk / cases.length).toFixed(4)),
    p95Ms,
    budgetMs,
    provenance: { live, synthetic: cases.length - live },
    failures,
  };
}

function main(): number {
  const args = process.argv.slice(2);
  const casesIndex = args.indexOf('--cases');
  const dir = casesIndex === -1 ? 'packages/bench/cases' : args[casesIndex + 1]!;
  const outIndex = args.indexOf('--out');
  const out = outIndex === -1 ? 'packages/bench/results.json' : args[outIndex + 1]!;

  const cases = loadCases(path.resolve(dir));
  if (cases.length === 0 && args.includes('--from-corpus')) {
    const generated = buildCases().map((testCase) => ({ ...testCase, provenance: 'synthetic' }));
    writeFileSync(out, JSON.stringify(runBench(generated), null, 2) + '\n');
    return 0;
  }
  const result = runBench(cases);
  writeFileSync(out, JSON.stringify(result, null, 2) + '\n');
  console.log(
    `cases=${result.cases} passed=${result.passed} accuracy=${result.accuracy} codes=${result.reasonCodeAccuracy} p95=${result.p95Ms}ms budget=${result.budgetMs}ms provenance=${JSON.stringify(result.provenance)}`,
  );
  for (const failure of result.failures) console.error('MISMATCH', failure);
  if (result.failures.length > 0) return 1;
  if (result.p95Ms > result.budgetMs) return 1;
  return 0;
}

if (process.argv[1] && process.argv[1].endsWith('run.js')) {
  process.exit(main());
}
