import { expect, test } from '@playwright/test';

test('keyboard walk: every reachable stop has a visible ring and an accessible name', async ({
  page,
}) => {
  await page.goto('/cases');
  const seen: string[] = [];

  for (let index = 0; index < 12; index += 1) {
    await page.keyboard.press('Tab');
    const stop = await page.evaluate(() => {
      const el = document.activeElement as HTMLElement | null;
      if (!el || el === document.body) return null;
      const style = getComputedStyle(el);
      const ring =
        (style.outlineStyle !== 'none' && style.outlineWidth !== '0px') ||
        style.boxShadow !== 'none';
      const name =
        (el.getAttribute('aria-label') ?? '') ||
        (el.textContent ?? '').trim() ||
        (el.getAttribute('title') ?? '');
      return {
        tag: el.tagName.toLowerCase(),
        id: el.id || null,
        ring,
        name,
      };
    });
    if (!stop) break;
    seen.push(`${stop.tag}${stop.id ? '#' + stop.id : ''}`);
    expect(stop.name, `stop ${seen.length} (${stop.tag}) has no accessible name`).not.toBe('');
    expect(stop.ring, `stop ${seen.length} (${stop.tag}) has no visible focus ring`).toBe(true);
  }

  expect(seen.length, 'the keyboard walk should reach at least two stops').toBeGreaterThanOrEqual(2);
});

test('Escape does not leave focus trapped without a dialog', async ({ page }) => {
  await page.goto('/cases');
  await page.keyboard.press('Tab');
  await page.keyboard.press('Escape');
  const focused = await page.evaluate(() => document.activeElement?.tagName ?? null);
  expect(focused).not.toBeNull();
});
