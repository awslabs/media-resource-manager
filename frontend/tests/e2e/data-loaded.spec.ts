// SPDX-License-Identifier: Apache-2.0
import { test, expect, trackConsoleErrors } from './support/auth-fixture';

/**
 * "Data loaded" happy paths for every table-heavy page.
 *
 * `feature-pages.spec.ts` only asserts a page-specific heading renders. That
 * catches wrong-page-mounted and crash-on-mount bugs, but it does not catch
 * a page whose backing API call returned an error or hung — the heading is
 * static, so it renders even when the table below it never populates.
 *
 * This spec goes one step further: after navigating to each list-heavy page,
 * wait until the Antd `Spin` loading indicator is gone AND either at least
 * one row is present OR an explicit empty state is shown. If the API broke,
 * the page will spin past the timeout and the spec fails.
 *
 * Non-list pages (`/settings`, `/buckets`) are intentionally omitted — they
 * don't render a table.
 */

type DataPage = {
  path: string;
  heading: string;
  // Optional custom table locator for pages that render multiple tables
  // (e.g. /users has both users and groups tables).
  tableLocator?: string;
};

const DATA_PAGES: DataPage[] = [
  { path: '/dashboard', heading: 'Workstations' },
  { path: '/workstations', heading: 'Workstations' },
  { path: '/users', heading: 'User Management', tableLocator: '.ant-table' },
  { path: '/images', heading: 'Images' },
  { path: '/pipelines', heading: 'Image Pipelines' },
  { path: '/software', heading: 'Software Management' },
  { path: '/regions', heading: 'Regional Hubs' },
  { path: '/filesystems', heading: 'Filesystems' },
  { path: '/data-transfer', heading: 'Data Transfer' },
  { path: '/dcv', heading: 'DCV Session Management' },
];

test.describe('data pages reach a stable loaded state', () => {
  for (const { path, heading, tableLocator } of DATA_PAGES) {
    test(`${path} finishes loading (rows OR empty state visible)`, async ({ page }) => {
      const errors = await trackConsoleErrors(page);

      await page.goto(path);
      await expect(page.getByRole('heading', { name: heading, level: 3 })).toBeVisible({
        timeout: 30_000,
      });

      const container = tableLocator ? page.locator(tableLocator).first() : page;

      // Data is "loaded" when EITHER a row appears OR an explicit empty
      // state appears. Race the two so an empty account doesn't false-fail.
      //
      // The dashboard renders workstation cards, not a table; also accept
      // any Antd card as the "loaded" signal there. Cards live at
      // .ant-card which is stable across Antd versions.
      const rows = container.locator('.ant-table-tbody > tr[data-row-key]').first();
      const cards = container.locator('.ant-card').first();
      const emptyState = container.locator('.ant-empty').first();

      await Promise.race([
        rows.waitFor({ timeout: 30_000 }).catch(() => null),
        cards.waitFor({ timeout: 30_000 }).catch(() => null),
        emptyState.waitFor({ timeout: 30_000 }).catch(() => null),
      ]);

      // At this point, at least one of the three should be visible. If none
      // is, the page is stuck loading — fail with a clear message.
      const [hasRow, hasCard, hasEmpty] = await Promise.all([
        rows.isVisible().catch(() => false),
        cards.isVisible().catch(() => false),
        emptyState.isVisible().catch(() => false),
      ]);
      expect(
        hasRow || hasCard || hasEmpty,
        `${path} did not reach a loaded state within 30s ` +
          `(no rows, no cards, no empty state visible — likely stuck on a spinner).`,
      ).toBe(true);

      // No leftover loading spinners on the container after the wait.
      // Antd shows .ant-spin-spinning while loading; it disappears when done.
      await expect(container.locator('.ant-spin-spinning')).toHaveCount(0, {
        timeout: 5_000,
      });

      expect(
        errors,
        `${path} loaded but produced console errors: ${errors.join(' | ')}`,
      ).toEqual([]);
    });
  }
});
