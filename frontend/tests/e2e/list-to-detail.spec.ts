// SPDX-License-Identifier: Apache-2.0
import { test, expect, trackConsoleErrors } from './support/auth-fixture';

/**
 * Parameterized list → detail navigation happy paths.
 *
 * The MRM console has several list pages that link into per-resource detail
 * pages via `useParams`. Each follows the same shape (Ant Design Table with
 * `data-row-key` rows and a Link on the first column). This spec iterates
 * over them so a regression in the shared list→detail plumbing surfaces once
 * per resource type rather than requiring one bespoke spec each.
 *
 * Independent from `smoke.spec.ts`'s `useParams` deep-link test, which
 * uses a fabricated ID to prove useParams resolves without a JS crash. Here
 * we use real IDs from the deployment so the detail page can actually
 * populate — a stronger correctness guarantee.
 *
 * Each case skips gracefully if the deployment has no resources of that
 * type, so an empty sandbox doesn't false-fail.
 */

type ListToDetailCase = {
  name: string;
  listPath: string;
  listHeading: string;
  detailPathPattern: RegExp;
  // Selector for the list's data table. Defaults to the first Antd table
  // on the page; some pages have multiple tables (users + groups) and need
  // a scoped selector.
  tableLocator?: string;
};

const CASES: ListToDetailCase[] = [
  {
    name: 'workstation',
    listPath: '/workstations',
    listHeading: 'Workstations',
    detailPathPattern: /\/workstations\/[^/]+(\?|$)/,
  },
  {
    name: 'user',
    listPath: '/users',
    listHeading: 'User Management',
    detailPathPattern: /\/users\/[^/]+(\?|$)/,
    // /users has both a users table and a groups table. Scope to the first.
    tableLocator: '.ant-table',
  },
  {
    name: 'filesystem',
    listPath: '/filesystems',
    listHeading: 'Filesystems',
    // The filesystems table links out to /storage/:id.
    detailPathPattern: /\/storage\/[^/]+(\?|$)/,
  },
  {
    name: 'software',
    listPath: '/software',
    listHeading: 'Software Management',
    detailPathPattern: /\/software\/[^/]+(\?|$)/,
  },
  {
    name: 'data-transfer task',
    listPath: '/data-transfer',
    listHeading: 'Data Transfer',
    detailPathPattern: /\/datasync\/tasks\/[^/]+(\?|$)/,
  },
];

test.describe('list → detail navigation', () => {
  for (const c of CASES) {
    test(`${c.name}: clicking a row from ${c.listPath} navigates to its detail page`, async ({ page }) => {
      const errors = await trackConsoleErrors(page);

      await page.goto(c.listPath);
      await expect(
        page.getByRole('heading', { name: c.listHeading, level: 3 }),
      ).toBeVisible({ timeout: 30_000 });

      const table = c.tableLocator ? page.locator(c.tableLocator).first() : page;
      const rows = table.locator('.ant-table-tbody > tr[data-row-key]');

      // Wait for the list to hydrate. Either a row appears (populated list)
      // or the Antd empty state appears (empty list). API calls can be
      // slow on first hit for some resource types.
      await Promise.race([
        rows.first().waitFor({ timeout: 30_000 }).catch(() => null),
        table.locator('.ant-empty').first().waitFor({ timeout: 30_000 }).catch(() => null),
      ]);

      const rowCount = await rows.count();
      if (rowCount === 0) {
        test.skip(true, `No ${c.name}s in this account — cannot exercise list→detail flow`);
        return;
      }

      const firstRow = rows.first();
      const nameLink = firstRow.locator('a').first();
      await expect(nameLink).toBeVisible({ timeout: 10_000 });

      await nameLink.click();

      // The Link uses window.location.href for a hard navigation. Wait for
      // the URL to match the expected detail path.
      await expect(page).toHaveURL(c.detailPathPattern, { timeout: 30_000 });

      // Detail page should mount its main region and at least one heading.
      // A page that fails to load its data would render only the shell
      // (which lives outside <main> for the Antd layout) and no h3.
      await expect(page.getByRole('main').or(page.locator('[role="main"]'))).toBeVisible({
        timeout: 30_000,
      });
      await expect(
        page.getByRole('main').getByRole('heading').first(),
      ).toBeVisible({ timeout: 30_000 });

      expect(
        errors,
        `${c.name} detail page produced console errors: ${errors.join(' | ')}`,
      ).toEqual([]);
    });
  }
});
