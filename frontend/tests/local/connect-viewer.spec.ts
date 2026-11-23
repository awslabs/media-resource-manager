// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * /connect/:instanceId in the real production build, with the real Amazon DCV
 * Web UI and Web Client SDKs, against a mocked API. The "gateway" is a closed
 * loopback port, so every connect fails: that exercises the error and Retry
 * UI and proves the viewer passes the token to the SDK, not to the URL or
 * storage.
 */
import { test, expect, type Page, type Route } from '@playwright/test';

const INSTANCE = 'i-0123456789abcdef0';
const DCV_TOKEN = 'local-test-dcv-connection-token';
// A closed port on loopback: connections are refused at once.
const DEAD_GATEWAY = 'https://127.0.0.1:9';

function signInJwt(): string {
  const b64 = (o: object) => Buffer.from(JSON.stringify(o)).toString('base64url');
  return `${b64({ alg: 'none' })}.${b64({ exp: Math.floor(Date.now() / 1000) + 3600, email: 'ana@example.com' })}.sig`;
}

const USER = { userId: 'ana@example.com', email: 'ana@example.com', firstName: 'Ana', lastName: 'Li', isAdmin: false, groups: [] };

interface MockOptions {
  browserGatewayUrl?: string;
  connectionHost?: string;
}

/** Mock config.json and POST /dcv for every page in the context. Returns the recorded /dcv bodies. */
async function mockBackend(page: Page, opts: MockOptions = {}) {
  const dcvCalls: any[] = [];
  const ctx = page.context();
  await ctx.route('**/config.json', (route: Route) =>
    route.fulfill({ json: { apiUrl: 'http://127.0.0.1:4173/mockapi', productName: 'Media Resource Manager', acronym: 'MRM', useCognitoAuth: false } }),
  );
  await ctx.route('**/mockapi/**', async (route: Route) => {
    const req = route.request();
    if (req.method() === 'OPTIONS') return route.fulfill({ status: 204 });
    if (req.url().endsWith('/dcv') && req.method() === 'POST') {
      dcvCalls.push({ body: req.postDataJSON(), auth: req.headers()['authorization'] });
      const host = opts.connectionHost ?? '127.0.0.1:9';
      return route.fulfill({
        json: {
          sessionId: 'console',
          connectionToken: DCV_TOKEN,
          connectionUrl: `https://${host}/?authToken=${DCV_TOKEN}#console`,
          quicConnectionUrl: `https://${host.replace(/:\d+$/, ':8444')}/?authToken=${DCV_TOKEN}#console`,
          ...(opts.browserGatewayUrl ? { browserGatewayUrl: opts.browserGatewayUrl } : {}),
        },
      });
    }
    return route.fulfill({ json: {} });
  });
  return dcvCalls;
}

async function signIn(page: Page) {
  await page.goto('/favicon.svg');
  await page.evaluate(([jwt, user]) => {
    sessionStorage.setItem('auth-token', jwt);
    sessionStorage.setItem('auth-user', user);
  }, [signInJwt(), JSON.stringify(USER)] as const);
}

async function expectTokenNotStored(page: Page) {
  expect(page.url()).not.toContain(DCV_TOKEN);
  const stored = await page.evaluate(() => JSON.stringify({ ...sessionStorage, ...localStorage }) + document.cookie);
  expect(stored).not.toContain(DCV_TOKEN);
}

test('signed out: /connect shows the sign-in page and never calls the API', async ({ page }) => {
  const calls = await mockBackend(page);
  await page.goto(`/connect/${INSTANCE}`);
  await expect(page.getByRole('button', { name: /sign in/i }).first()).toBeVisible();
  expect(calls).toHaveLength(0);
});

test('CloudFront path: the SDK connects to browserGatewayUrl with the token; failure shows Retry, no trust prompt', async ({ page }) => {
  const calls = await mockBackend(page, { browserGatewayUrl: DEAD_GATEWAY, connectionHost: 'gw.example.com:8443' });
  const sockets: string[] = [];
  page.on('websocket', (ws) => sockets.push(ws.url()));
  await signIn(page);
  await page.goto(`/connect/${INSTANCE}`);

  await expect(page.getByText("Couldn't reach the workstation's gateway")).toBeVisible({ timeout: 30_000 });
  await expect(page.getByTestId('trust-gateway')).toHaveCount(0);
  expect(calls).toHaveLength(1);
  expect(calls[0].body).toMatchObject({ action: 'create-session', serverId: INSTANCE, sessionName: 'Ana Li' });
  expect(calls[0].auth).toMatch(/^Bearer /);
  // Token login only: the SDK opens /ws (never the gateway's /auth) and the token is not in the WebSocket URL.
  expect(sockets.length).toBeGreaterThan(0);
  for (const url of sockets) {
    expect(url.startsWith('wss://127.0.0.1:9/')).toBe(true);
    expect(url).not.toContain('/auth');
    expect(url).not.toContain(DCV_TOKEN);
  }
  await expectTokenNotStored(page);

  // Retry starts a new session (a new token) and remounts the viewer.
  await page.getByRole('button', { name: 'Retry' }).click();
  await expect(page.getByTestId('dcv-viewer')).toBeVisible();
  await expect(page.getByText("Couldn't reach the workstation's gateway")).toBeVisible({ timeout: 30_000 });
  expect(calls).toHaveLength(2);
});

test('direct mode with a load balancer gateway shows the trust-the-gateway-once prompt', async ({ page }) => {
  await mockBackend(page, { connectionHost: 'mrm-gw-0123456789abcdef.elb.us-east-1.amazonaws.com:8443' });
  await page.route('https://mrm-gw-0123456789abcdef.elb.us-east-1.amazonaws.com:8443/**', (r) => r.abort());
  await signIn(page);
  await page.goto(`/connect/${INSTANCE}`);
  await expect(page.getByText("Couldn't reach the workstation's gateway")).toBeVisible({ timeout: 30_000 });
  const link = page.getByTestId('trust-gateway').getByRole('link', { name: 'the gateway' });
  await expect(link).toHaveAttribute('href', 'https://mrm-gw-0123456789abcdef.elb.us-east-1.amazonaws.com:8443/');
  await expect(link).toHaveAttribute('target', '_blank');
  await expectTokenNotStored(page);
});

test('new-tab handoff: window.open from a signed-in console tab opens a signed-in viewer', async ({ page }) => {
  const calls = await mockBackend(page, { browserGatewayUrl: DEAD_GATEWAY });
  await signIn(page);
  await page.goto('/favicon.svg');
  // What openBrowserViewer() does: same-origin window.open without noopener.
  const [viewer] = await Promise.all([
    page.context().waitForEvent('page'),
    page.evaluate((id) => { window.open(`/connect/${id}`, '_blank'); }, INSTANCE),
  ]);
  await expect(viewer.getByText("Couldn't reach the workstation's gateway")).toBeVisible({ timeout: 30_000 });
  expect(calls).toHaveLength(1);
  await expectTokenNotStored(viewer);
});

test('the SDK license files are served next to the viewer', async ({ request }) => {
  for (const path of ['/connect/EULA.txt', '/connect/third-party-licenses.txt', '/dcvsdk/EULA.txt', '/dcvsdk/dcvjs/dcv.js']) {
    const res = await request.get(path);
    expect(res.status(), path).toBe(200);
    expect((await res.text()).length, path).toBeGreaterThan(100);
  }
});
