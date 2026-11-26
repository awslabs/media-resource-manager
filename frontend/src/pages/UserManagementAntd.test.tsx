// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Users page loads when the session ends during load (#157): apiCall answers
 * 401 with an empty body, or there is no token. The page must not parse the
 * empty body (SyntaxError: Unexpected end of input) or log "No current user".
 * The API, auth and layout are mocked; the page and its table are real.
 */
import React, { act } from 'react';
import { createRoot, Root } from 'react-dom/client';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

let token: string | null;
let responses: Record<string, () => Response>;
const calls: string[] = [];
const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } });

vi.mock('../utils/api', () => ({
  apiCall: vi.fn(async (endpoint: string) => {
    calls.push(endpoint);
    return (responses[endpoint] ?? (() => json({})))();
  }),
}));
vi.mock('../utils/auth', () => ({ getAuthToken: () => token }));
vi.mock('../components/AppLayoutAntd', () => ({
  default: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}));

// eslint-disable-next-line import/first
import UserManagementAntd from './UserManagementAntd';

let container: HTMLDivElement;
let root: Root;
let errorSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  token = 'token';
  responses = {};
  calls.length = 0;
  errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
  window.matchMedia = window.matchMedia || ((query: string) => ({
    matches: false, media: query, onchange: null,
    addListener: () => undefined, removeListener: () => undefined,
    addEventListener: () => undefined, removeEventListener: () => undefined, dispatchEvent: () => false,
  }) as unknown as MediaQueryList);
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  document.body.innerHTML = '';
  errorSpy.mockRestore();
});

const flush = () => act(async () => { await new Promise((r) => setTimeout(r, 0)); });

async function renderPage() {
  await act(async () => {
    root.render(<UserManagementAntd user={{}} isAdmin onSignOut={() => undefined} />);
  });
  await flush();
}

/** Every console.error call, as text, including the message of any Error argument. */
const loggedErrors = (): string[] =>
  errorSpy.mock.calls.map((args: unknown[]) =>
    args.map((a: unknown) => (a instanceof Error ? `${a.name}: ${a.message}` : String(a))).join(' '));

describe('UserManagementAntd load when the session ends', () => {
  it('does not parse the empty body of a 401 for users or groups', async () => {
    responses = {
      users: () => new Response(null, { status: 401 }),
      groups: () => new Response(null, { status: 401 }),
    };
    await renderPage();
    expect(calls).toEqual(expect.arrayContaining(['users', 'groups']));
    expect(loggedErrors().filter((e) => /SyntaxError|fetching (users|groups)/.test(e))).toEqual([]);
    expect(document.body.textContent).not.toContain('Failed to fetch users');
  });

  it('does not request users or groups, or log an error, when there is no token', async () => {
    token = null;
    await renderPage();
    expect(calls).not.toContain('users');
    expect(calls).not.toContain('groups');
    expect(loggedErrors().filter((e) => /No current user|fetching (users|groups)/.test(e))).toEqual([]);
    expect(document.body.textContent).not.toContain('Failed to fetch users');
  });

  it('logs the status and shows the alert for another failed response, without parsing it', async () => {
    responses = {
      users: () => new Response(null, { status: 500 }),
      groups: () => new Response(null, { status: 503 }),
    };
    await renderPage();
    const errors = loggedErrors();
    expect(errors.filter((e) => /SyntaxError/.test(e))).toEqual([]);
    expect(errors).toContain('Error fetching users: HTTP 500');
    expect(errors).toContain('Error fetching groups: HTTP 503');
    expect(document.body.textContent).toContain('Failed to fetch users');
  });

  it('lists the users from a successful response', async () => {
    responses = {
      users: () => json([{ userId: 'u1', email: 'ana@example.org', firstName: 'Ana', lastName: 'Lopez', enabled: true, createdAt: '2026-01-01T00:00:00Z' }]),
      groups: () => json([]),
    };
    await renderPage();
    expect(document.body.textContent).toContain('ana@example.org');
    expect(loggedErrors().filter((e) => /fetching (users|groups)/.test(e))).toEqual([]);
  });
});
