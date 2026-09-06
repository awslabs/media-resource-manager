// SPDX-License-Identifier: Apache-2.0
import { test, expect, trackConsoleErrors, escapeRegex } from './support/auth-fixture';

/**
 * Frontend smoke tests — focused on react-router surfaces.
 *
 * Every assertion here maps to one of the react-router APIs the app uses.
 * If a react-router bump (major or minor) breaks any of these, we catch it
 * before merge. Not intended to be a feature test suite — that's separate.
 *
 * react-router APIs exercised:
 *   - <BrowserRouter> + <Routes> + <Route>  → route mounting
 *   - <Navigate>                            → "/" redirect
 *   - useNavigate()                         → programmatic navigation via sidebar clicks
 *   - <Link> / <NavLink>                    → declarative navigation
 *   - useParams()                           → :param resolution on details pages
 *   - useSearchParams()                     → query-string round-trip
 *   - useLocation()                         → path-driven UI (sidebar highlight)
 */

// Top-level routes that render without needing a specific record.
// Adjust this list if App.tsx routes change.
const TOP_LEVEL_ROUTES: Array<{ path: string; label: string }> = [
  { path: '/dashboard', label: 'Dashboard' },
  { path: '/workstations', label: 'Workstations' },
  { path: '/images', label: 'Images' },
  { path: '/pipelines', label: 'Pipelines' },
  { path: '/software', label: 'Software' },
  { path: '/users', label: 'Users' },
  { path: '/filesystems', label: 'Filesystems' },
  { path: '/data-transfer', label: 'Data Transfer' },
  { path: '/buckets', label: 'Buckets' },
  { path: '/regions', label: 'Regions' },
  { path: '/dcv', label: 'DCV Sessions' },
  { path: '/settings', label: 'Settings' },
];

test.describe('react-router smoke', () => {
  test('root path redirects to /dashboard (Navigate component)', async ({ page }) => {
    const errors = await trackConsoleErrors(page);
    await page.goto('/');
    await expect(page).toHaveURL(/\/dashboard(\?|#|$)/, { timeout: 30_000 });
    expect(errors, `Console errors on redirect: ${errors.join(' | ')}`).toEqual([]);
  });

  test('unknown path does not crash the app', async ({ page }) => {
    const errors = await trackConsoleErrors(page);
    await page.goto('/definitely-not-a-real-route-xyz');
    // App may either redirect to dashboard, render a 404, or render an empty
    // Routes block. Any of those is acceptable; a JS crash is not.
    await page.waitForLoadState('networkidle', { timeout: 30_000 });
    expect(errors).toEqual([]);
  });

  for (const { path, label } of TOP_LEVEL_ROUTES) {
    test(`${label}: direct navigation to ${path} renders without JS errors`, async ({ page }) => {
      const errors = await trackConsoleErrors(page);
      await page.goto(path);
      // Wait for the URL to settle (React Router may async-resolve).
      await expect(page).toHaveURL(new RegExp(escapeRegex(path)), {
        timeout: 30_000,
      });
      // Wait for the app shell to be visible — any main region is fine.
      await expect(page.getByRole('main').or(page.locator('[role="main"]'))).toBeVisible({
        timeout: 30_000,
      });
      expect(
        errors,
        `${path} produced console errors: ${errors.join(' | ')}`
      ).toEqual([]);
    });
  }

  test('sidebar navigation between routes updates URL (useNavigate/Link)', async ({ page }) => {
    const errors = await trackConsoleErrors(page);
    await page.goto('/dashboard');
    await expect(page).toHaveURL(/\/dashboard/);

    // Click a couple of sidebar items and confirm URL updates.
    // Use accessible name matching so it works across Cloudscape and Antd
    // sidebar variants. Adjust these names if the sidebar labels change.
    const clickTargets: Array<{ name: RegExp; expectPath: RegExp }> = [
      { name: /workstations/i, expectPath: /\/workstations(\?|#|$)/ },
      { name: /images/i, expectPath: /\/images(\?|#|$)/ },
      { name: /users/i, expectPath: /\/users(\?|#|$)/ },
      { name: /dashboard/i, expectPath: /\/dashboard(\?|#|$)/ },
    ];

    for (const { name, expectPath } of clickTargets) {
      const link = page.getByRole('link', { name }).or(
        page.getByRole('menuitem', { name })
      ).first();
      await link.click();
      await expect(page).toHaveURL(expectPath, { timeout: 15_000 });
    }
    expect(errors).toEqual([]);
  });

  test('search params round-trip (useSearchParams)', async ({ page }) => {
    const errors = await trackConsoleErrors(page);
    // WorkstationManagement reads useSearchParams(); a category=any query
    // should be accepted without crash.
    await page.goto('/workstations?category=all');
    await expect(page).toHaveURL(/[?&]category=all/);
    await expect(page.getByRole('main').or(page.locator('[role="main"]'))).toBeVisible({
      timeout: 30_000,
    });
    expect(errors).toEqual([]);
  });

  test('back/forward preserves route state (BrowserRouter history)', async ({ page }) => {
    const errors = await trackConsoleErrors(page);
    await page.goto('/dashboard');
    await page.goto('/workstations');
    await page.goto('/images');
    await page.goBack();
    await expect(page).toHaveURL(/\/workstations/);
    await page.goBack();
    await expect(page).toHaveURL(/\/dashboard/);
    await page.goForward();
    await expect(page).toHaveURL(/\/workstations/);
    expect(errors).toEqual([]);
  });

  test('deep link to a details route resolves useParams without crash', async ({ page }) => {
    const errors = await trackConsoleErrors(page);
    // We don't know a valid ID, so we use a placeholder. The page may show
    // "not found" or an empty state — that's fine. What we're verifying is
    // that useParams() resolves, the route mounts, and no JS error fires.
    await page.goto('/workstations/i-doesnotexist');
    await expect(page).toHaveURL(/\/workstations\/i-doesnotexist/);
    await page.waitForLoadState('networkidle', { timeout: 30_000 });
    expect(errors, `useParams route produced errors: ${errors.join(' | ')}`).toEqual([]);
  });
});
