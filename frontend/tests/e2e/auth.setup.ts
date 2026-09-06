// SPDX-License-Identifier: Apache-2.0
import { test as setup, expect } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';

/**
 * One-time interactive login.
 *
 * Playwright opens a headed browser, navigates to the app, and waits for
 * the user to complete the Cognito login flow. Once the app-side dashboard
 * renders (React app has hydrated and react-router landed on /dashboard),
 * the browser's storageState is written to tests/e2e/.auth/user.json.
 *
 * Subsequent test runs load that storageState so they skip login.
 *
 * Run this whenever the stored state expires (Cognito default: 60 min access
 * token, but refresh tokens work in-flight so this may last much longer):
 *   npm run test:e2e:setup
 */

const AUTH_FILE = 'tests/e2e/.auth/user.json';
const SESSION_STORAGE_FILE = 'tests/e2e/.auth/session-storage.json';

setup('authenticate via Cognito (manual login)', async ({ page }) => {
  // Interactive login can take a while (SSO redirect, MFA prompt, user typing).
  // Override Playwright's default 30 s test timeout so the waitForURL below
  // actually gets its full 5-minute budget.
  setup.setTimeout(6 * 60 * 1000);

  // Ensure the .auth directory exists with owner-only permissions.
  const authDir = path.dirname(AUTH_FILE);
  fs.mkdirSync(authDir, { recursive: true, mode: 0o700 });
  try {
    fs.chmodSync(authDir, 0o700);
  } catch {
    /* ignore — best effort on non-POSIX filesystems */
  }

  // Force headed for setup so the human can actually log in.
  // (The project config keeps headless=true for the rest of the suite.)
  if (process.env.HEADLESS === 'true') {
    throw new Error(
      'auth.setup.ts requires a headed browser for manual login. ' +
      'Do not set HEADLESS=true when running the setup project.'
    );
  }

  await page.goto('/');

  console.log('');
  console.log('┌──────────────────────────────────────────────────────────────┐');
  console.log('│  Playwright is waiting for you to log in.                    │');
  console.log('│  Complete the Cognito sign-in flow in the opened browser.    │');
  console.log('│  Once you land on the dashboard, this test will save state.  │');
  console.log('└──────────────────────────────────────────────────────────────┘');
  console.log('');

  // Wait up to 5 minutes for the dashboard to render. Anything on the
  // dashboard page that is stable and only appears when authenticated works
  // as a signal — here we wait for the URL to include /dashboard AND for
  // any element with role="main" or a nav sidebar to appear.
  await page.waitForURL(/\/dashboard(\?|#|$)/, { timeout: 5 * 60 * 1000 });

  // Belt-and-suspenders: wait for a top-level app shell element to render.
  // We look for common candidates that indicate the SPA has hydrated.
  await expect(async () => {
    const hasMain = await page.getByRole('main').count();
    const hasNav = await page.getByRole('navigation').count();
    if (hasMain === 0 && hasNav === 0) {
      throw new Error('App shell has not rendered yet');
    }
  }).toPass({ timeout: 30_000 });

  // Save cookies + localStorage via Playwright's built-in helper.
  await page.context().storageState({ path: AUTH_FILE });

  // The MRM frontend stores its Cognito auth tokens in sessionStorage
  // (see frontend/src/utils/auth.ts). Playwright's storageState() does NOT
  // capture sessionStorage — it's per-tab and cleared on close. Save it
  // separately so specs can restore it via addInitScript.
  const sessionData: Record<string, string> = await page.evaluate(() => {
    const out: Record<string, string> = {};
    for (let i = 0; i < sessionStorage.length; i++) {
      const key = sessionStorage.key(i);
      if (key) out[key] = sessionStorage.getItem(key) ?? '';
    }
    return out;
  });

  if (!sessionData['auth-token']) {
    throw new Error(
      'Login appears to have completed but sessionStorage does not contain an "auth-token" entry. ' +
      'The app may have changed how it persists auth. Check frontend/src/utils/auth.ts.',
    );
  }

  fs.writeFileSync(SESSION_STORAGE_FILE, JSON.stringify(sessionData, null, 2), { mode: 0o600 });
  // Tighten permissions on both auth files. These contain a short-lived
  // Cognito ID token that grants the same access as the logged-in user
  // until expiration (default 1 hour). Owner-read-only defeats a
  // co-located/shared-workstation read.
  for (const f of [AUTH_FILE, SESSION_STORAGE_FILE]) {
    try {
      fs.chmodSync(f, 0o600);
    } catch {
      /* ignore — best effort on non-POSIX filesystems */
    }
  }

  console.log(`✅ Auth state saved (mode 0600):`);
  console.log(`   cookies+localStorage: ${AUTH_FILE}`);
  console.log(`   sessionStorage:       ${SESSION_STORAGE_FILE}  (${Object.keys(sessionData).length} keys)`);
});
