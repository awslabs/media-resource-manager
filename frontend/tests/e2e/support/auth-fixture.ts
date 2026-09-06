// SPDX-License-Identifier: Apache-2.0
/**
 * Shared Playwright test fixture that restores the app's Cognito auth state
 * before each test. Import `test` and `expect` from here (instead of
 * `@playwright/test`) in any spec that needs to run authenticated.
 *
 * How it works:
 *   1. `auth.setup.ts` persists Cognito ID token to
 *      `tests/e2e/.auth/session-storage.json` (the app stores tokens in
 *       sessionStorage — see frontend/src/utils/auth.ts).
 *   2. This fixture reads that file at spec load, and injects the values
 *      into `sessionStorage` via `page.addInitScript` on every navigation.
 *   3. If the file is missing, tests fail immediately with a clear message
 *      telling the user to run `npm run test:e2e:setup`.
 *
 * Also exports a `trackConsoleErrors(page)` helper that collects unexpected
 * console errors, filtering out known non-JS noise (favicon 404s, HTTP-layer
 * `Failed to load resource` messages, etc.).
 */
import { test as base, expect, type Page } from '@playwright/test';
import fs from 'node:fs';

const SESSION_STORAGE_FILE = 'tests/e2e/.auth/session-storage.json';

const sessionStorageData: Record<string, string> = fs.existsSync(
  SESSION_STORAGE_FILE,
)
  ? JSON.parse(fs.readFileSync(SESSION_STORAGE_FILE, 'utf8'))
  : {};

if (Object.keys(sessionStorageData).length === 0) {
  // Bail loudly at test-collection time rather than letting every spec
  // fail with a confusing "landed on login page" error.
  throw new Error(
    `No sessionStorage state found at ${SESSION_STORAGE_FILE}.\n` +
      'Run `npm run test:e2e:setup` first (or re-run if the state has expired — ' +
      'Cognito ID tokens are ~1 hour).',
  );
}

export const test = base.extend<{}>({
  page: async ({ page }, use) => {
    await page.addInitScript((data: Record<string, string>) => {
      for (const [k, v] of Object.entries(data)) {
        sessionStorage.setItem(k, v);
      }
    }, sessionStorageData);
    await use(page);
  },
});

export { expect };

/**
 * Escape a string for use inside a regular expression.
 * Standard JS pattern — every regex metacharacter gets a preceding backslash.
 * Use when building a `new RegExp(...)` from a value that isn't a regex
 * literal (e.g. a route path from a test table).
 */
export function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Collect unexpected client-side JS errors during a test.
 *
 * Filters out known-noisy console errors that aren't JS regressions:
 *   - Favicon / DevTools noise.
 *   - `Failed to load resource: ... status of N` — HTTP-layer signal
 *     emitted by the browser for any non-2xx response. Expected in tests
 *     that intentionally hit non-existent IDs.
 *   - Cancelled image/asset requests (`net::ERR_ABORTED`).
 *
 * Everything else — including `pageerror` (unhandled exceptions), React
 * invariant violations, hook order errors, and general `console.error` —
 * lands in the returned array.
 */
export async function trackConsoleErrors(page: Page): Promise<string[]> {
  const errors: string[] = [];
  page.on('pageerror', (err) => errors.push(`pageerror: ${err.message}`));
  page.on('console', (msg) => {
    if (msg.type() === 'error') {
      const text = msg.text();
      if (
        text.includes('favicon') ||
        text.includes('DevTools') ||
        text.match(/net::ERR_ABORTED.*\.(png|jpg|svg)$/) ||
        text.startsWith('Failed to load resource:')
      ) {
        return;
      }
      errors.push(`console.error: ${text}`);
    }
  });
  return errors;
}
