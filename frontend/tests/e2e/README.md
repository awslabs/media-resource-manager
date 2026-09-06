# Frontend E2E Tests

Playwright-based end-to-end tests for the MRM web console. The suite is organized in tiers so you can pick how much coverage you need for a given change.

**The frontend also has unit tests** (Vitest) for `src/utils/` — see `npm test` at the repo root or `cd frontend && npm test`. Unit tests are fast (~1s), don't need AWS, and cover token parsing, session-storage handling, and API URL construction. Run those in parallel with these e2e tests for full coverage.

## Test tiers

| Tier | File | Purpose |
|---|---|---|
| **Smoke** | [`smoke.spec.ts`](./smoke.spec.ts) | React-router API surfaces. Every assertion maps to a specific react-router API (Navigate, Routes/Route, useNavigate, Link, useParams, useSearchParams, history). Catches router regressions and "app doesn't boot" bugs. |
| **Feature pages** | [`feature-pages.spec.ts`](./feature-pages.spec.ts) | Each top-level page renders **its own** page-specific content beyond the app shell. Catches wrong-page-mounted bugs, silent page-component crashes, and pages hanging on an infinite spinner from a broken initial `useEffect`. |
| **Feature flows** | [`list-to-detail.spec.ts`](./list-to-detail.spec.ts) | List → detail navigation across five resource types (workstations, users, filesystems, software, data-transfer tasks). Each exercises a different backend data model. Catches API contract drift and useParams issues on real data. Skips gracefully for empty lists. |
| **Data loaded** | [`data-loaded.spec.ts`](./data-loaded.spec.ts) | Every table-heavy page reaches a stable loaded state — rows OR cards OR explicit empty state visible, no leftover loading spinner. Catches pages stuck on a spinner because their backing API broke, hung, or returned an error the UI didn't handle. Covers 10 pages: dashboard, workstations, users, images, pipelines, software, regions, filesystems, data-transfer, DCV. |

Together this is a **foundation**, not a comprehensive e2e suite. It catches most regressions from runtime-dep bumps and refactors, but doesn't cover feature correctness (form submissions, wizards, mutations). See [Extending the suite](#extending-the-suite) below for guidance on adding more coverage.

## When to run

- Before merging any PR that changes `react-router`, `react-router-dom`, or the routing structure in `App.tsx`.
- Before merging any dependency PR that bumps a runtime frontend package (antd, cloudscape, react, vite, AWS SDK).
- Before releasing any refactor that touches shared UI (auth, layout, config loading, side navigation).
- As part of the [test-deploy runbook](../../../docs/TEST_DEPLOY.md) — Step 5 in that runbook invokes this suite.

You do **not** need to run this for lockfile-only patch bumps on transitive devDeps (postcss, browserslist, brace-expansion). `npm run build` covers those.

## Setup (one time per machine)

```bash
cd frontend
npm ci
npm run test:e2e:install     # downloads the chromium browser binary
```

## Configuration

The suite figures out its target URL in this order (first match wins):

1. `TEST_BASE_URL` environment variable — explicit override, always respected.
2. **Auto-discovery** from the frontend CloudFormation stack's `WebsiteUrl` output. Uses your `AWS_PROFILE` (or default profile) and `AWS_REGION` (or `us-east-1`).

The stack name is derived from `context.productName` in your local `cdk.json` — first-letter-of-each-word, uppercased, plus `-Frontend`. So `"Media Resource Manager"` → `MRM-Frontend`, `"Studio Workstations"` → `SW-Frontend`. Matches the acronym logic in `scripts/deploy-pipeline.yaml`.

Auto-discovery covers the common case: point your shell at your sandbox account and just run the tests.

```bash
export AWS_PROFILE=<your-non-prod-mrm-profile>
export AWS_REGION=us-east-1              # if not already default
npm run test:e2e                          # URL auto-discovered
```

Explicit URL override, if you need to test against a specific deployment (staging, fork, etc.):

```bash
TEST_BASE_URL=https://<your-cloudfront-domain> npm run test:e2e
```

Explicit stack override, if your fork doesn't follow the `<Acronym>-Frontend` naming:

```bash
export MRM_TEST_STACK_NAME=<your-frontend-stack>
```

Do **not** commit `TEST_BASE_URL` values, AWS credentials, or `cdk.json` (it's already gitignored) to the repo.

## Setup (one time per auth session)

Cognito auth is captured interactively and reused across runs. Playwright opens a browser; you log in manually; the session is saved to `tests/e2e/.auth/user.json` (gitignored).

```bash
npm run test:e2e:setup
```

Complete the Cognito login in the opened browser. The setup step waits for the app to land on `/dashboard`, then saves the storageState and exits.

Re-run the setup step whenever the state expires (you'll see the smoke suite fail because it lands on the login page instead of the dashboard).

## Running the suite

```bash
# Headless
npm run test:e2e

# Watch the browser as it runs (helpful when debugging failures)
npm run test:e2e:headed

# Interactive test explorer
npm run test:e2e:ui
```

Failures produce:

- `playwright-report/index.html` — full HTML report with traces
- `test-results/**/trace.zip` — replayable trace per failed spec
- Console errors captured in the spec output

## What the tests cover

### Smoke — react-router surfaces

| React Router API | Tested by |
|---|---|
| `<BrowserRouter>` + `<Routes>` + `<Route>` | Direct navigation to every top-level route |
| `<Navigate>` | Root path `/` redirects to `/dashboard` |
| `useNavigate()` | Sidebar clicks update the URL |
| `<Link>` / `<NavLink>` | Same — sidebar navigation |
| `useParams()` | Deep link `/workstations/i-doesnotexist` mounts without crash |
| `useSearchParams()` | Query string `?category=all` on `/workstations` round-trips |
| `useLocation()` | Sidebar highlight follows the URL (implicit) |
| History API | Back/forward navigation preserves route state |

### Feature pages — each page renders its own content

For each top-level route (`/dashboard`, `/workstations`, `/images`, `/pipelines`, `/software`, `/settings`, `/regions`, `/filesystems`, `/data-transfer`, `/dcv`, `/buckets`, `/users`), a page-specific indicator (typically an H3 heading with the expected title) is asserted visible. That catches:

- Wrong page component mounted for a route (route-table typo).
- Page component crashes silently on mount.
- Initial `useEffect` / config load breaks and the page hangs on a spinner.

### Feature flows — list → detail

`list-to-detail.spec.ts` exercises the most common navigation shape in the app across five resource types: land on a list page, click a row, verify the detail page renders with the correct entity ID.

- `/workstations` → `/workstations/:instanceId` — EC2 workstation data
- `/users` → `/users/:userId` — Cognito user data
- `/filesystems` → `/storage/:storageId` — FSx / S3 filesystem data
- `/software` → `/software/:softwareId` — software repository data
- `/data-transfer` → `/datasync/tasks/:taskId` — DataSync task data

Each case hits a different backend contract, so an API-shape regression in any one of them fails independently. Cases skip gracefully when the corresponding list is empty (an empty sandbox doesn't false-fail).

To add a new resource type to this parameterized test, append a new entry to the `CASES` array in `list-to-detail.spec.ts`.

### Data loaded — every table-heavy page reaches a stable state

`data-loaded.spec.ts` verifies each list page finishes loading its primary data region. "Finished" means one of:

- At least one Antd table row (`.ant-table-tbody tr[data-row-key]`) is visible.
- At least one Antd card (`.ant-card`) is visible (for card-based layouts like the dashboard).
- An explicit Antd empty state (`.ant-empty`) is visible.
- **And** no leftover loading spinner (`.ant-spin-spinning`) remains.

If a backing API returned an error or hung, the page would render its heading (so `feature-pages` still passes) but never resolve to any of the above — and this spec fails with a clear "did not reach a loaded state within 30s" message.

To add a new page to this check, append a new entry to `DATA_PAGES` in `data-loaded.spec.ts`.

### What every spec asserts implicitly

Every spec also fails on any `pageerror` or unexpected `console.error` — react-router runtime issues (invariant violations, missing provider, hook order), page-component crashes, and any other JS error surface as one of those. HTTP-layer signals (`Failed to load resource`, favicon 404s, cancelled asset requests) are filtered out — see `trackConsoleErrors` in `support/auth-fixture.ts`.

## What the tests **don't** cover

Non-goals for this suite in its current shape:

- **Feature mutations** — creating workstations, uploading images, submitting forms, changing settings. Adding these requires a per-run test-data seeding/cleanup strategy that this suite doesn't have yet.
- **Multi-step wizards** — image creation, workstation creation. Add specs for these when the wizards get touched.
- **Error paths** — 500 responses, expired sessions, network failures. Would need API mocking or fault injection.
- **Multi-role auth** — admin vs. non-admin vs. read-only. Setup currently captures one identity; add a second `auth.setup.ts` variant if you need multi-role tests.
- **DCV / streaming integration** — the workstation-connect flow is not exercised.
- **API contract testing** — lives in `test/authz.test.ts` and `test/database-construct.test.ts` at the repo root, run by jest.
- **Cross-browser** — chromium only. Reasonable for the router-surface bar we're setting.
- **Visual regression** — no snapshot testing.

## Extending the suite

**Add a spec when:**
- A PR touches a page that isn't covered by a feature-page assertion yet.
- A PR adds or changes a critical flow (a new wizard, a new action button).
- A dep bump lands and you want a specific regression guard alongside it.

**Naming convention:** `{feature}.spec.ts` in `tests/e2e/`. Import `test`, `expect`, and `trackConsoleErrors` from `./support/auth-fixture` — that gives you authenticated pages and console-error tracking with no boilerplate.

**Pattern:**

```typescript
import { test, expect, trackConsoleErrors } from './support/auth-fixture';

test('my feature test', async ({ page }) => {
  const errors = await trackConsoleErrors(page);
  await page.goto('/some-route');
  // ... assertions ...
  expect(errors).toEqual([]);
});
```

**Where to grow next:**
- Multi-role fixtures (non-admin user setup).
- Form-happy-path specs for the workstation-create, image-create, and user-invite wizards.
- Assert admin-only actions are gated (button hidden/disabled for non-admin).
- Assert cross-page state (create workstation on management page → appears on dashboard).

## Structure

```
tests/e2e/
├── README.md                ← you are here
├── auth.setup.ts            ← one-time interactive Cognito login → auth files
├── smoke.spec.ts            ← react-router surface tests (18)
├── feature-pages.spec.ts    ← per-page content indicators (12)
├── list-to-detail.spec.ts   ← parameterized list → detail flows (5)
├── data-loaded.spec.ts      ← every table page reaches stable state (10)
├── support/
│   └── auth-fixture.ts      ← shared: authenticated page fixture + console tracking
└── .auth/                   ← auth state (gitignored, never commit)
    ├── user.json
    └── session-storage.json
```

## Security / trust model

Running `test:e2e:setup` persists a short-lived Cognito **ID token** to disk so subsequent test runs skip the manual login. Concretely:

- `tests/e2e/.auth/user.json` — cookies + localStorage from Playwright's `storageState()`.
- `tests/e2e/.auth/session-storage.json` — the `auth-token` (Cognito ID token) and decoded `auth-user` from the app's `sessionStorage`. The MRM frontend stores its session tokens in `sessionStorage`, which Playwright's `storageState()` does not capture, so we save it separately and inject it back via `addInitScript` before each test.

**What these files grant:**

- Anyone with read access to the files can call the MRM backend as the logged-in user for as long as the token is valid.
- Cognito ID token lifetime defaults to 1 hour. After that the file is inert.

**Guardrails already in place:**

- Both files are written with **mode `0600`** — owner read/write only.
- The `.auth/` directory is written with mode `0700`.
- The whole `tests/e2e/.auth/` path is gitignored (via `.gitignore`) so the tokens never enter version control.
- The setup targets your **non-prod** MRM deployment. Do not run against production.

**Do not:**

- Commit `tests/e2e/.auth/` — check `.gitignore` before pushing.
- Upload `test-results/` or `playwright-report/` as CI build artifacts without redacting: traces (`trace.zip`) and videos (`.webm`) captured on failed tests can include the auth token in a request header. If you set up CI for this suite, gate artifact upload on success only, or scrub traces before upload.
- Run this suite against a production account. The auth token grants real access; a leaked prod token is a real incident.

**If you suspect a token leaked:**

- Cognito ID tokens cannot be individually revoked, but they expire in ~1 hour. Force the user's refresh token to be revoked (`aws cognito-idp admin-user-global-sign-out`) so no new ID tokens can be minted for the compromised session.
- Rotate any credentials that may have been used through the API within the token's lifetime.

## Adding a new spec

1. Create `tests/e2e/<name>.spec.ts`. It automatically uses the `chromium` project, which auto-depends on the `setup` project — so your specs run authenticated with no boilerplate.
2. Use `trackConsoleErrors(page)` from `smoke.spec.ts` (or copy it) if the spec should fail on JS errors. Most should.
3. If the spec needs a different auth state (e.g. a non-admin user), create a second setup file and a second project in `playwright.config.ts`.
