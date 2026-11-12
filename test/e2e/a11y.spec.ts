import { expect, test } from '@playwright/test';
import { readFileSync } from 'node:fs';
import path from 'node:path';

const axeSource = readFileSync(
  path.resolve('node_modules/axe-core/axe.min.js'),
  'utf8',
);

const ROUTES = ['/', '/cases', '/mandates/new'];

test.describe('accessibility', () => {
  for (const route of ROUTES) {
    test(`${route} has no WCAG 2.2 AA violations`, async ({ page }) => {
      await page.goto(route);
      await page.addScriptTag({ content: axeSource });
      const results = await page.evaluate(async () => {
        return await (window as unknown as {
          axe: { run: (opts: unknown) => Promise<{ violations: unknown[] }> };
        }).axe.run({
          runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'] },
        });
      });
      expect(results.violations, JSON.stringify(results.violations, null, 2)).toEqual([]);
    });
  }
});

test('the route renders one main landmark and a title', async ({ page }) => {
  await page.goto('/cases');
  await expect(page.locator('main')).toHaveCount(1);
  await expect(page).toHaveTitle(/Autonomous Buyer OS/i);
});

test('the stylesheet path resolves (no unstyled shell)', async ({ page }) => {
  await page.goto('/cases');
  const background = await page.evaluate(() =>
    getComputedStyle(document.body).backgroundColor,
  );
  expect(background).not.toBe('rgba(0, 0, 0, 0)');
});
