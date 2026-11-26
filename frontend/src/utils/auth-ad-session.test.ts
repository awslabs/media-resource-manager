// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * AD sign-in (useCognitoAuth=false) keeps its 1-hour session after #85: the
 * token from /auth/ldap has no refresh token, so nothing is refreshed, no
 * Cognito call is made, and an expired token ends the session as before.
 * fetch is mocked: the config files, /auth/ldap and the API.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  canRefreshSession,
  clearSession,
  getAuthToken,
  getFreshAuthToken,
  signInWithLDAP,
  signOut,
  startTokenRefresh,
} from './auth';
import { apiCall, setApiUrl } from './api';

const API = 'https://api.example.com/prod';
const CONFIG = { useCognitoAuth: false, adMode: 'managed', apiUrl: `${API}/`, region: 'us-east-1' };

const now = () => Math.floor(Date.now() / 1000);
/** An AD session token shaped like the one ldap-auth issues (unsigned here). */
function adToken(expiresIn: number): string {
  const header = btoa(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
  const body = btoa(JSON.stringify({ username: 'aduser', email: 'aduser@example.com', isAdmin: false, exp: now() + expiresIn }));
  return `${header}.${body}.sig`;
}

const calls: string[] = [];
let api: (init: RequestInit) => Response;
const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

beforeEach(() => {
  sessionStorage.clear();
  calls.length = 0;
  setApiUrl(API);
  api = () => json(200, {});
  vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit = {}) => {
    calls.push(url);
    if (url === '/config.json' || url === '/config-dev.json') return json(200, CONFIG);
    if (url === `${API}/auth/ldap`) return json(200, { token: adToken(3600) });
    return api(init);
  }));
  vi.stubGlobal('location', { ...window.location, reload: vi.fn() });
  vi.spyOn(console, 'log').mockImplementation(() => {});
});

afterEach(() => {
  clearSession();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const cognitoCalls = () => calls.filter(u => u.includes('cognito-idp') || u.includes('/oauth2/'));

describe('AD sign-in session', () => {
  it('stores no refresh token and has no session refresh', async () => {
    await signInWithLDAP('aduser', 'pw-for-test'); // pragma: allowlist secret
    expect(sessionStorage.getItem('auth-token')).not.toBeNull();
    expect(sessionStorage.getItem('auth-refresh-token')).toBeNull();
    expect(canRefreshSession()).toBe(false);
  });

  it('sends a valid token as the caller gave it, without a Cognito call', async () => {
    const token = adToken(3600);
    sessionStorage.setItem('auth-token', token);
    const headers = { Authorization: `Bearer ${token}` };
    await apiCall('/workstations', { headers });
    expect(fetch).toHaveBeenLastCalledWith(`${API}/workstations`, expect.objectContaining({ headers }));
    expect(cognitoCalls()).toHaveLength(0);
  });

  it('treats a token near expiry as valid until it expires, as before', async () => {
    const token = adToken(60);
    sessionStorage.setItem('auth-token', token);
    expect(getAuthToken()).toBe(token);
    await expect(getFreshAuthToken()).resolves.toBe(token);
    expect(cognitoCalls()).toHaveLength(0);
  });

  it('ends the session when the 1-hour token has expired', async () => {
    sessionStorage.setItem('auth-token', adToken(-1));
    sessionStorage.setItem('auth-user', JSON.stringify({ username: 'aduser' }));
    expect(getAuthToken()).toBeNull();
    await expect(getFreshAuthToken()).resolves.toBeNull();
  });

  it('schedules no background refresh', async () => {
    vi.useFakeTimers();
    sessionStorage.setItem('auth-token', adToken(3600));
    const before = vi.getTimerCount();
    startTokenRefresh();
    expect(vi.getTimerCount()).toBe(before);
    await vi.advanceTimersByTimeAsync(2 * 3600 * 1000);
    expect(calls).toHaveLength(0);
  });

  it('clears the session and reloads on a 401, with one request and no refresh', async () => {
    sessionStorage.setItem('auth-token', adToken(3600));
    sessionStorage.setItem('auth-user', JSON.stringify({ username: 'aduser' }));
    api = () => json(401, {});
    await apiCall('/workstations', { headers: { Authorization: 'Bearer x' } });
    expect(calls.filter(u => u.startsWith(API))).toHaveLength(1);
    expect(cognitoCalls()).toHaveLength(0);
    expect(sessionStorage.getItem('auth-token')).toBeNull();
    expect(sessionStorage.getItem('auth-user')).toBeNull();
    expect(window.location.reload).toHaveBeenCalledOnce();
  });

  it('signs out locally without a Cognito call', async () => {
    sessionStorage.setItem('auth-token', adToken(3600));
    await expect(signOut(true)).resolves.toBe(false);
    expect(sessionStorage.getItem('auth-token')).toBeNull();
    expect(cognitoCalls()).toHaveLength(0);
  });
});
