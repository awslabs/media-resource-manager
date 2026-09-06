// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Unit tests for the API layer helpers.
 *
 * `apiCall` wraps fetch with three responsibilities that unit tests can
 * verify without a real backend:
 *   1. URL construction — slash normalization between base URL and endpoint.
 *   2. Auth failure handling — 401 responses clear the session.
 *   3. Error propagation — network errors bubble up unless they look like
 *      an auth failure, in which case the session is cleared.
 *
 * Actual network behavior is covered by the Playwright e2e suite.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { apiCall, setApiUrl } from './api';

/** Build a fake Response we can hand back from a mocked fetch. */
function fakeResponse(init: { status: number; body?: unknown } = { status: 200 }): Response {
  return new Response(JSON.stringify(init.body ?? {}), {
    status: init.status,
    headers: { 'Content-Type': 'application/json' },
  });
}

describe('apiCall URL construction', () => {
  beforeEach(() => {
    sessionStorage.clear();
    setApiUrl('https://api.example.com/prod');
    vi.stubGlobal('fetch', vi.fn(() => Promise.resolve(fakeResponse())));
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('prepends a leading slash to endpoints that lack one', async () => {
    await apiCall('workstations');
    expect(fetch).toHaveBeenCalledWith(
      'https://api.example.com/prod/workstations',
      expect.anything(),
    );
  });

  it('keeps a leading slash the caller already provided', async () => {
    await apiCall('/workstations');
    expect(fetch).toHaveBeenCalledWith(
      'https://api.example.com/prod/workstations',
      expect.anything(),
    );
  });

  it('strips a trailing slash from the configured base URL', async () => {
    setApiUrl('https://api.example.com/prod/');
    await apiCall('/workstations');
    expect(fetch).toHaveBeenCalledWith(
      'https://api.example.com/prod/workstations',
      expect.anything(),
    );
  });

  it('preserves query strings on the endpoint', async () => {
    await apiCall('/workstations?category=all');
    expect(fetch).toHaveBeenCalledWith(
      'https://api.example.com/prod/workstations?category=all',
      expect.anything(),
    );
  });

  it('passes through fetch options (method, headers, body)', async () => {
    await apiCall('/workstations', {
      method: 'POST',
      headers: { Authorization: 'Bearer xyz' },
      body: JSON.stringify({ name: 'test' }),
    });
    expect(fetch).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({
        method: 'POST',
        headers: { Authorization: 'Bearer xyz' },
        body: JSON.stringify({ name: 'test' }),
      }),
    );
  });
});

describe('apiCall response handling', () => {
  beforeEach(() => {
    sessionStorage.clear();
    sessionStorage.setItem('auth-token', 'anything');
    sessionStorage.setItem('auth-user', JSON.stringify({ email: 'a@b.c' }));
    setApiUrl('https://api.example.com/prod');
    // window.location.reload is called on 401 — stub it so the test env
    // doesn't try to reload jsdom.
    vi.stubGlobal('location', { ...window.location, reload: vi.fn() });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('returns the response as-is for a 2xx status', async () => {
    vi.stubGlobal('fetch', vi.fn(() => Promise.resolve(fakeResponse({ status: 200, body: { ok: true } }))));

    const response = await apiCall('/health');

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ ok: true });
    expect(sessionStorage.getItem('auth-token')).toBe('anything');
    expect(window.location.reload).not.toHaveBeenCalled();
  });

  it('returns the response as-is for non-401 error statuses (caller decides)', async () => {
    // The API layer is intentionally lightweight — 4xx/5xx that isn't a
    // 401 is passed through. Individual pages surface user-facing errors.
    vi.stubGlobal('fetch', vi.fn(() => Promise.resolve(fakeResponse({ status: 500 }))));

    const response = await apiCall('/workstations');

    expect(response.status).toBe(500);
    expect(sessionStorage.getItem('auth-token')).toBe('anything');
    expect(window.location.reload).not.toHaveBeenCalled();
  });

  it('clears the session and reloads on 401', async () => {
    vi.stubGlobal('fetch', vi.fn(() => Promise.resolve(fakeResponse({ status: 401 }))));

    await apiCall('/workstations');

    expect(sessionStorage.getItem('auth-token')).toBeNull();
    expect(sessionStorage.getItem('auth-user')).toBeNull();
    expect(window.location.reload).toHaveBeenCalledOnce();
  });

  it('clears the session on a network error that looks like an auth failure', async () => {
    // Some paths through the aws-sdk / cognito flows throw errors whose
    // message includes "No current user" — treat that as an auth wipe
    // signal even without a real HTTP response.
    vi.stubGlobal(
      'fetch',
      vi.fn(() => Promise.reject(new Error('No current user'))),
    );

    await expect(apiCall('/workstations')).rejects.toThrow('No current user');

    expect(sessionStorage.getItem('auth-token')).toBeNull();
    expect(sessionStorage.getItem('auth-user')).toBeNull();
    expect(window.location.reload).toHaveBeenCalledOnce();
  });

  it('re-throws unrelated network errors without touching the session', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() => Promise.reject(new Error('Network request failed'))),
    );

    await expect(apiCall('/workstations')).rejects.toThrow('Network request failed');

    expect(sessionStorage.getItem('auth-token')).toBe('anything');
    expect(sessionStorage.getItem('auth-user')).not.toBeNull();
    expect(window.location.reload).not.toHaveBeenCalled();
  });
});

describe('setApiUrl', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('changes the base URL used by subsequent apiCall invocations', async () => {
    vi.stubGlobal('fetch', vi.fn(() => Promise.resolve(fakeResponse())));

    setApiUrl('https://first.example.com');
    await apiCall('/x');
    expect(fetch).toHaveBeenLastCalledWith('https://first.example.com/x', expect.anything());

    setApiUrl('https://second.example.com');
    await apiCall('/x');
    expect(fetch).toHaveBeenLastCalledWith('https://second.example.com/x', expect.anything());
  });
});
