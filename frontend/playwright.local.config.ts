// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0
import { defineConfig, devices } from '@playwright/test';

/**
 * Local, offline Playwright tests against the production build served on
 * 127.0.0.1, with config.json and the API mocked in the browser. No AWS
 * account or sign-in needed. Run after scripts/fetch-dcv-web-sdk.sh and
 * `npm run build`:
 *
 *   npm run test:e2e:local
 */
const PORT = 4173;

export default defineConfig({
  testDir: './tests/local',
  // The Web Client SDK retries a failed connect about 10 times (~13 s) before
  // it gives up, and some tests fail a connect twice.
  timeout: 120_000,
  workers: 1,
  reporter: [['list']],
  use: {
    baseURL: `http://127.0.0.1:${PORT}`,
    trace: 'retain-on-failure',
    headless: true,
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  webServer: {
    // Loopback only.
    command: `npx vite preview --host 127.0.0.1 --port ${PORT} --strictPort`,
    url: `http://127.0.0.1:${PORT}/`,
    reuseExistingServer: false,
    timeout: 60_000,
  },
});
