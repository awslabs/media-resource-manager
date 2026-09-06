// SPDX-License-Identifier: Apache-2.0
import { test, expect, trackConsoleErrors, escapeRegex } from './support/auth-fixture';

/**
 * Feature happy-path tests: each top-level page renders its own content,
 * not just the shared app shell.
 *
 * The smoke suite verifies routes mount and no JS crashes. This suite goes
 * one step further and asserts a **page-specific** indicator (usually the H3
 * page heading) appears within the main content region. That catches:
 *
 *   - "Wrong page component got mounted" (route table mistake).
 *   - "Page component crashed silently and rendered only the shell."
 *   - "The initial useEffect / config load broke and the page hangs on a
 *     spinner forever."
 *
 * When a page changes its title, update the corresponding entry here.
 * When a new top-level route is added, add an entry for it.
 */

type PageProbe = {
  path: string;
  // What must appear on the page beyond the app shell.
  // Every entry uses a role-based, name-based selector so it survives
  // most style refactors and is robust to DOM restructures.
  indicator: {
    role: 'heading' | 'link' | 'button' | 'main';
    name: string | RegExp;
    level?: number;
  };
};

// Kept in sync with App.tsx <Route path=...>. When you add or rename a
// top-level route, update this table.
const PAGES: PageProbe[] = [
  { path: '/dashboard', indicator: { role: 'heading', name: 'Workstations', level: 3 } },
  { path: '/workstations', indicator: { role: 'heading', name: 'Workstations', level: 3 } },
  { path: '/users', indicator: { role: 'heading', name: 'User Management', level: 3 } },
  { path: '/images', indicator: { role: 'heading', name: 'Images', level: 3 } },
  { path: '/pipelines', indicator: { role: 'heading', name: 'Image Pipelines', level: 3 } },
  { path: '/software', indicator: { role: 'heading', name: 'Software Management', level: 3 } },
  { path: '/settings', indicator: { role: 'heading', name: 'Settings', level: 3 } },
  { path: '/regions', indicator: { role: 'heading', name: 'Regional Hubs', level: 3 } },
  { path: '/filesystems', indicator: { role: 'heading', name: 'Filesystems', level: 3 } },
  { path: '/data-transfer', indicator: { role: 'heading', name: 'Data Transfer', level: 3 } },
  { path: '/dcv', indicator: { role: 'heading', name: 'DCV Session Management', level: 3 } },
  // BucketsAntd renders no <Title> — it uses breadcrumbs + a toolbar. Match
  // on the "Upload Files" button which only exists on this page.
  { path: '/buckets', indicator: { role: 'button', name: /Upload Files/i } },
];

test.describe('feature pages render page-specific content', () => {
  for (const { path, indicator } of PAGES) {
    test(`${path} renders ${indicator.role} "${indicator.name}"`, async ({ page }) => {
      const errors = await trackConsoleErrors(page);
      await page.goto(path);
      await expect(page).toHaveURL(new RegExp(escapeRegex(path)), {
        timeout: 30_000,
      });

      const locator =
        indicator.role === 'heading'
          ? page.getByRole('heading', { name: indicator.name, level: indicator.level })
          : page.getByRole(indicator.role, { name: indicator.name });

      await expect(locator.first()).toBeVisible({ timeout: 30_000 });
      expect(
        errors,
        `${path} rendered but produced console errors: ${errors.join(' | ')}`,
      ).toEqual([]);
    });
  }
});
