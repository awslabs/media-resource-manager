// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Dashboard workstation load when the session ends (#157): apiCall answers
 * 401 with an empty body. The page must not parse it (SyntaxError: Unexpected
 * end of input), and must not take an error body for the workstation list.
 * The API, auth and layout are mocked; the page and its table are real.
 */
import React, { act } from 'react';
import { createRoot, Root } from 'react-dom/client';
import { MemoryRouter } from 'react-router-dom';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

let workstationsResponse: () => Response;
const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

vi.mock('../utils/api', () => ({
  apiCall: vi.fn(async (endpoint: string) => (endpoint === 'workstations' ? workstationsResponse() : json(200, {}))),
}));
vi.mock('../utils/auth', () => ({ getAuthToken: () => 'token', handleAuthError: () => false }));
vi.mock('../components/AppLayoutAntd', () => ({
  default: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}));

// eslint-disable-next-line import/first
import DashboardAntd from './DashboardAntd';

let container: HTMLDivElement;
let root: Root;
let errorSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
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
    root.render(
      <MemoryRouter>
        <DashboardAntd user={{}} onSignOut={() => undefined} />
      </MemoryRouter>,
    );
  });
  await flush();
}

const loggedErrors = (): string[] =>
  errorSpy.mock.calls.map((args: unknown[]) =>
    args.map((a: unknown) => (a instanceof Error ? `${a.name}: ${a.message}` : String(a))).join(' '));

describe('DashboardAntd workstation load', () => {
  it('does not parse the empty body of a 401', async () => {
    workstationsResponse = () => new Response(null, { status: 401 });
    await renderPage();
    expect(loggedErrors().filter((e) => /SyntaxError|fetching workstations/.test(e))).toEqual([]);
  });

  it('logs the status of another failed response and does not use its body as the list', async () => {
    workstationsResponse = () => json(500, { error: 'Internal error' });
    await renderPage();
    const errors = loggedErrors();
    expect(errors).toContain('Error fetching workstations: HTTP 500');
    expect(errors.filter((e) => /is not a function|SyntaxError/.test(e))).toEqual([]);
  });
});
