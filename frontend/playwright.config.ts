// SPDX-License-Identifier: Apache-2.0
import { defineConfig, devices } from '@playwright/test';
import { execSync } from 'node:child_process';
import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';

/**
 * Playwright configuration for MRM end-to-end smoke tests.
 *
 * Target URL resolution (first match wins):
 *   1. TEST_BASE_URL environment variable — explicit override, always respected.
 *   2. CloudFormation `<Acronym>-Frontend` stack's `WebsiteUrl` output —
 *      auto-discovered via the AWS CLI when TEST_BASE_URL is not set.
 *      The stack acronym derives from `context.productName` in the root
 *      cdk.json (same logic as scripts/deploy-pipeline.yaml). Uses your
 *      AWS_PROFILE (or default profile) and AWS_REGION (or us-east-1).
 *   3. If neither works, the config throws with instructions.
 *
 * Override the stack name directly with MRM_TEST_STACK_NAME if needed
 * (e.g. a fork whose stacks aren't named `<Acronym>-Frontend`).
 *
 * Auth: Cognito hosted UI. Tests use storageState persisted by
 * `tests/e2e/auth.setup.ts` (run it once, log in manually, the state is reused).
 */

/** Derive the stack acronym from cdk.json's productName. */
function acronymFromCdkJson(): string | null {
  const cdkJsonPath = resolve(__dirname, '..', 'cdk.json');
  if (!existsSync(cdkJsonPath)) return null;

  let productName: string | undefined;
  try {
    const raw = JSON.parse(readFileSync(cdkJsonPath, 'utf8'));
    productName = raw?.context?.productName;
  } catch {
    return null;
  }
  if (!productName || typeof productName !== 'string') return null;

  // Match the transform in scripts/deploy-pipeline.yaml buildspec:
  //   ACRONYM = first letter of each whitespace-separated word, uppercased.
  //   "Media Resource Manager" -> "MRM"
  //   "CloudEdit"              -> "C"
  //   "Studio Workstations"    -> "SW"
  return productName
    .trim()
    .split(/\s+/)
    .map((w) => w[0]?.toUpperCase() ?? '')
    .join('');
}

function resolveStackName(): string {
  if (process.env.MRM_TEST_STACK_NAME) return process.env.MRM_TEST_STACK_NAME;
  const acronym = acronymFromCdkJson();
  if (acronym) return `${acronym}-Frontend`;
  // Fall back to the default MRM acronym so the error message below stays
  // useful (mentions the exact stack name that was attempted).
  return 'MRM-Frontend';
}

function resolveBaseUrl(): string {
  const explicit = process.env.TEST_BASE_URL;
  if (explicit) return explicit;

  const stackName = resolveStackName();
  const region =
    process.env.AWS_REGION ?? process.env.AWS_DEFAULT_REGION ?? 'us-east-1';
  const profileArg = process.env.AWS_PROFILE
    ? `--profile ${process.env.AWS_PROFILE}`
    : '';

  try {
    const url = execSync(
      `aws ${profileArg} --region ${region} cloudformation describe-stacks ` +
        `--stack-name ${stackName} ` +
        `--query "Stacks[0].Outputs[?OutputKey=='WebsiteUrl'].OutputValue" ` +
        `--output text`,
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] },
    ).trim();

    if (!url || url === 'None') {
      throw new Error(`Stack ${stackName} has no WebsiteUrl output`);
    }
    return url;
  } catch (err) {
    throw new Error(
      [
        'Could not determine test base URL.',
        '',
        'Tried:',
        '  1. TEST_BASE_URL env var (not set)',
        `  2. Auto-discover WebsiteUrl output from stack "${stackName}" in region "${region}"`,
        `     (failed: ${(err as Error).message.split('\n')[0]})`,
        '',
        'Fixes (pick one):',
        '  - Set TEST_BASE_URL explicitly:',
        '      export TEST_BASE_URL=https://<your-cloudfront-domain>',
        '  - Configure AWS CLI to reach your non-prod MRM deployment:',
        '      export AWS_PROFILE=<your-profile>',
        '      export AWS_REGION=<your-region>',
        '    The stack name is derived from context.productName in cdk.json',
        `    (currently resolves to "${stackName}").`,
        '  - Override the stack name if your fork uses different naming:',
        '      export MRM_TEST_STACK_NAME=<your-stack>',
      ].join('\n'),
    );
  }
}

const BASE_URL = resolveBaseUrl();
const HEADLESS = process.env.PWDEBUG || process.env.HEADED ? false : true;

export default defineConfig({
  testDir: './tests/e2e',
  fullyParallel: false, // Cognito rate-limits; serialize
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  workers: 1,
  reporter: [
    ['list'],
    ['html', { outputFolder: 'playwright-report', open: 'never' }],
  ],
  use: {
    baseURL: BASE_URL,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    video: 'retain-on-failure',
    headless: HEADLESS,
  },
  projects: [
    {
      name: 'setup',
      testMatch: /auth\.setup\.ts/,
      use: {
        ...devices['Desktop Chrome'],
        // No storageState — this project creates it.
      },
    },
    {
      // The smoke project does NOT depend on `setup` — running `test:e2e`
      // should not re-trigger the manual login. Run `test:e2e:setup` once
      // to seed .auth/user.json, then this project reuses it on every run.
      // If the state file is missing or expired, specs will fail on their
      // first navigation (landing on the login page instead of /dashboard),
      // which is a clear signal to re-run setup.
      name: 'chromium',
      testIgnore: /auth\.setup\.ts/,
      use: {
        ...devices['Desktop Chrome'],
        storageState: 'tests/e2e/.auth/user.json',
      },
    },
  ],
});
