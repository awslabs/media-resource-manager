// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * AD sign-in (useCognitoAuth=false) and session refresh (#85). A token with
 * auth_time is renewed through POST /auth/ldap/refresh about 5 minutes before
 * it expires, up to the 12-hour cap. A token without auth_time (issued before
 * this change) is never refreshed and keeps the old 1-hour behaviour. No
 * Cognito call is made in AD mode. fetch is mocked: the config files,
 * /auth/ldap, /auth/ldap/refresh and the API.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  AD_SESSION_MAX_SECONDS,
  canRefreshSession,
  clearSession,
  getAuthToken,
  getCurrentUser,
  getFreshAuthToken,
  signInWithLDAP,
  signOut,
  startTokenRefresh,
} from './auth';
import { apiCall, setApiUrl } from './api';

const API = 'https://api.example.com/prod';
const CONFIG = { useCognitoAuth: false, adMode: 'managed', apiUrl: `${API}/`, region: 'us-east-1' };

const now = () => Math.floor(Date.now() / 1000);
let serial = 0;
/**
 * An AD session token shaped like the one ldap-auth issues (unsigned here).
 * Without authTime it is a token from before session refresh existed.
 */
function adToken(expiresIn: number, authTime?: number, extra: Record<string, unknown> = {}): string {
  serial += 1;
  const header = btoa(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
  const body = btoa(JSON.stringify({
    username: 'aduser', email: 'aduser@example.com', isAdmin: false,
    iat: now(), exp: now() + expiresIn, n: serial,
    ...(authTime === undefined ? {} : { auth_time: authTime }),
    ...extra,
  }));
  return `${header}.${body}.sig${serial}`;
}

const calls: string[] = [];
const requests: { url: string; init: RequestInit }[] = [];
let api: (init: RequestInit) => Response;
let refreshEndpoint: (init: RequestInit) => Response | Promise<Response>;
const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

beforeEach(() => {
  sessionStorage.clear();
  calls.length = 0;
  requests.length = 0;
  setApiUrl(API);
  api = () => json(200, {});
  refreshEndpoint = () => json(401, { error: 'Session can not be refreshed. Sign in again.' });
  vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit = {}) => {
    calls.push(url);
    requests.push({ url, init });
    if (url === '/config.json' || url === '/config-dev.json') return json(200, CONFIG);
    if (url === `${API}/auth/ldap`) return json(200, { token: adToken(3600, now()) });
    if (url === `${API}/auth/ldap/refresh`) return refreshEndpoint(init);
    return api(init);
  }));
  vi.stubGlobal('location', { ...window.location, reload: vi.fn() });
  logged = [];
  for (const level of ['log', 'info', 'warn', 'error', 'debug'] as const) {
    vi.spyOn(console, level).mockImplementation((...args: unknown[]) => {
      logged.push(args.map(a => (typeof a === 'string' ? a : JSON.stringify(a))).join(' '));
    });
  }
});

afterEach(() => {
  clearSession();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

let logged: string[];

const cognitoCalls = () => calls.filter(u => u.includes('cognito-idp') || u.includes('/oauth2/'));
const refreshCalls = () => requests.filter(r => r.url === `${API}/auth/ldap/refresh`);
const bearer = (init: RequestInit) => (new Headers(init.headers).get('Authorization') || '').replace(/^Bearer /, '');
const apiCalls = () => requests.filter(r => r.url.startsWith(API) && !r.url.includes('/auth/ldap'));

describe('AD sign-in', () => {
  it('stores no refresh token, and a new sign-in can be refreshed', async () => {
    await signInWithLDAP('aduser', 'pw-for-test'); // pragma: allowlist secret
    expect(sessionStorage.getItem('auth-token')).not.toBeNull();
    expect(sessionStorage.getItem('auth-refresh-token')).toBeNull();
    expect(canRefreshSession()).toBe(true);
    expect(cognitoCalls()).toHaveLength(0);
  });
});

describe('AD session refresh', () => {
  const signedIn = (expiresIn: number, authTime = now() - 3000, extra: Record<string, unknown> = {}) => {
    const token = adToken(expiresIn, authTime, extra);
    sessionStorage.setItem('auth-token', token);
    sessionStorage.setItem('auth-user', JSON.stringify({ username: 'aduser', attributes: { 'custom:isAdmin': 'false' } }));
    return token;
  };

  it('refreshes 5 minutes before expiry with the current token and keeps the new admin status', async () => {
    vi.useFakeTimers();
    const old = signedIn(10 * 60);
    const fresh = adToken(3600, now() - 3000, { isAdmin: true });
    refreshEndpoint = () => json(200, { success: true, token: fresh });

    startTokenRefresh();
    await vi.advanceTimersByTimeAsync(4 * 60 * 1000);
    expect(refreshCalls()).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(61 * 1000);

    expect(refreshCalls()).toHaveLength(1);
    expect(refreshCalls()[0].init.method).toBe('POST');
    expect(bearer(refreshCalls()[0].init)).toBe(old);
    expect(sessionStorage.getItem('auth-token')).toBe(fresh);
    expect(getCurrentUser().attributes['custom:isAdmin']).toBe('true');
    expect(cognitoCalls()).toHaveLength(0);
  });

  it('refreshes once for several calls with an expiring token, and sends each with the new token', async () => {
    const old = signedIn(60);
    const fresh = adToken(3600, now() - 3000);
    let release!: () => void;
    const gate = new Promise<void>(r => { release = r; });
    refreshEndpoint = async () => { await gate; return json(200, { token: fresh }); };

    const pending = ['/a', '/b', '/c'].map(p => apiCall(p, { headers: { Authorization: `Bearer ${old}` } }));
    await Promise.resolve();
    release();
    const results = await Promise.all(pending);

    expect(results.map(r => r.status)).toEqual([200, 200, 200]);
    expect(refreshCalls()).toHaveLength(1);
    expect(apiCalls().map(c => bearer(c.init))).toEqual([fresh, fresh, fresh]);
  });

  it('refreshes once and retries when the API answers 401', async () => {
    const old = signedIn(3600);
    const fresh = adToken(3600, now() - 3000);
    refreshEndpoint = () => json(200, { token: fresh });
    api = (init) => (bearer(init) === fresh ? json(200, {}) : json(401, {}));
    const res = await apiCall('/workstations', { headers: { Authorization: `Bearer ${old}` } });
    expect(res.status).toBe(200);
    expect(refreshCalls()).toHaveLength(1);
  });

  it('signs out when the refresh is refused (disabled user, cap, bad token)', async () => {
    vi.useFakeTimers();
    signedIn(5 * 60 + 1);
    refreshEndpoint = () => json(401, { error: 'Session can not be refreshed. Sign in again.' });
    startTokenRefresh();
    await vi.advanceTimersByTimeAsync(2 * 1000);
    expect(refreshCalls()).toHaveLength(1);
    expect(sessionStorage.getItem('auth-token')).toBeNull();
    expect(sessionStorage.getItem('auth-user')).toBeNull();
    expect(window.location.reload).toHaveBeenCalled();
  });

  it('retries when the directory is unavailable (503) while the token is still valid', async () => {
    vi.useFakeTimers();
    signedIn(6 * 60);
    const fresh = adToken(3600, now() - 3000);
    let attempts = 0;
    refreshEndpoint = () => (++attempts === 1 ? json(503, { error: 'Directory unavailable, try again' }) : json(200, { token: fresh }));
    startTokenRefresh();
    await vi.advanceTimersByTimeAsync(61 * 1000);
    expect(attempts).toBe(1);
    expect(sessionStorage.getItem('auth-token')).not.toBeNull();
    await vi.advanceTimersByTimeAsync(61 * 1000);
    expect(attempts).toBe(2);
    expect(sessionStorage.getItem('auth-token')).toBe(fresh);
  });

  it('does not refresh a token that already lasts until the 12-hour cap', async () => {
    vi.useFakeTimers();
    const authTime = now() - (AD_SESSION_MAX_SECONDS - 600);
    const token = adToken(600, authTime);
    sessionStorage.setItem('auth-token', token);
    expect(canRefreshSession()).toBe(false);
    startTokenRefresh();
    await vi.advanceTimersByTimeAsync(10 * 60 * 1000);
    expect(refreshCalls()).toHaveLength(0);
  });

  it('does not refresh an expired token', async () => {
    signedIn(-1);
    expect(canRefreshSession()).toBe(false);
    expect(getAuthToken()).toBeNull();
    await expect(getFreshAuthToken()).resolves.toBeNull();
    expect(refreshCalls()).toHaveLength(0);
  });

  it('logs no token or sign-in name', async () => {
    const old = signedIn(60);
    const fresh = adToken(3600, now() - 3000);
    refreshEndpoint = () => json(200, { token: fresh });
    await apiCall('/a', { headers: { Authorization: `Bearer ${old}` } });
    refreshEndpoint = () => json(401, {});
    api = () => json(401, {});
    await apiCall('/b', { headers: { Authorization: `Bearer ${fresh}` } });
    expect(logged.some(l => l.includes('refused'))).toBe(true);
    for (const line of logged) {
      for (const secret of [old, fresh, old.split('.')[1], fresh.split('.')[1], 'aduser']) expect(line).not.toContain(secret);
    }
  });
});

describe('AD tokens from before session refresh (no auth_time)', () => {
  it('cannot be refreshed', () => {
    sessionStorage.setItem('auth-token', adToken(3600));
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
