import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

const routePath = 'apps/web/app/api/verdicts/[verdictId]/route.ts';
const loaderPath = 'apps/web/lib/verdicts.ts';

test('the verdict GET route reads stored rows and never re-evaluates', () => {
  const route = readFileSync(routePath, 'utf8');
  assert.doesNotMatch(route, /\bevaluate\s*\(/, 'route must not call the auditor');
  assert.doesNotMatch(route, /from '@buyeros\/core'/, 'route imports no decision code');
  assert.match(route, /loadVerdict/);
});

test('the verdict loader is read-only SQL', () => {
  const loader = readFileSync(loaderPath, 'utf8');
  const writes = loader.match(/\b(INSERT|UPDATE|DELETE|TRUNCATE)\b/g) ?? [];
  assert.deepEqual(writes, []);
  assert.match(loader, /FROM verdict WHERE id = \$1/);
  assert.match(loader, /FROM verdict_clause WHERE verdict_id = \$1/);
});
