// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Cognito session refresh (#85): the console keeps a signed-in user's session
 * by getting a new ID token with the Cognito refresh token, before the ID
 * token expires and when the API answers 401. fetch is mocked: /config.json,
 * the Cognito endpoint and the API.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  clearSession,
  getAuthToken,
  getFreshAuthToken,
  refreshSession,
  signInWithCognitoCredentials,
  signOut,
  startTokenRefresh,
} from './auth';
import { apiCall, setApiUrl } from './api';

const COGNITO = 'https://cognito-idp.us-east-1.amazonaws.com/';
const API = 'https://api.example.com/prod';
const CONFIG = {
  useCognitoAuth: true,
  cognitoClientId: 'test-client-id',
  cognitoDomain: 'https://auth.example.com',
  region: 'us-east-1',
  apiUrl: `${API}/`,
};

const now = () => Math.floor(Date.now() / 1000);
let serial = 0;
/** A JWT-shaped ID token (unsigned) with a unique marker so logs can be searched for it. */
function idToken(expiresIn: number): string {
  serial += 1;
  const header = btoa(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const body = btoa(JSON.stringify({ exp: now() + expiresIn, email: 'user@example.com', marker: `id-${serial}` }));
  return `${header}.${body}.sig-${serial}`;
}
const REFRESH = 'refresh-token-value-do-not-log';

type Handler = (url: string, init: RequestInit) => Promise<Response> | Response;
let cognito: Handler;
let api: Handler;
const calls: { url: string; init: RequestInit }[] = [];
const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
const target = (init: RequestInit) => new Headers(init.headers).get('X-Amz-Target') || '';
const bearer = (init: RequestInit) => (new Headers(init.headers).get('Authorization') || '').replace(/^Bearer /, '');
const cognitoCalls = (name: string) => calls.filter(c => c.url === COGNITO && target(c.init).endsWith(name));
const apiCalls = () => calls.filter(c => c.url.startsWith(API));

/** Cognito accepts the refresh token and returns this ID token. */
const refreshesTo = (token: string): Handler => (_url, init) => {
  const body = JSON.parse(String(init.body));
  if (body.AuthFlow === 'REFRESH_TOKEN_AUTH' && body.AuthParameters.REFRESH_TOKEN === REFRESH) {
    return json(200, { AuthenticationResult: { IdToken: token, AccessToken: 'access', ExpiresIn: 3600 } });
  }
  return json(400, { __type: 'NotAuthorizedException', message: 'Invalid Refresh Token' });
};
const refused: Handler = () => json(400, { __type: 'NotAuthorizedException', message: 'Refresh Token has been revoked' });

let logged: string[];

beforeEach(() => {
  sessionStorage.clear();
  localStorage.clear();
  calls.length = 0;
  setApiUrl(API);
  cognito = refused;
  api = () => json(200, { ok: true });
  vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit = {}) => {
    calls.push({ url, init });
    // vitest runs with import.meta.env.DEV, so the app loads /config-dev.json
    if (url === '/config.json' || url === '/config-dev.json') return json(200, CONFIG);
    if (url === COGNITO) return cognito(url, init);
    return api(url, init);
  }));
  vi.stubGlobal('location', { ...window.location, origin: 'https://console.example.com', reload: vi.fn() });
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

function signedIn(expiresIn: number) {
  const token = idToken(expiresIn);
  sessionStorage.setItem('auth-token', token);
  sessionStorage.setItem('auth-user', JSON.stringify({ email: 'user@example.com' }));
  sessionStorage.setItem('auth-refresh-token', REFRESH);
  return token;
}

const expectSignedOut = () => {
  expect(sessionStorage.getItem('auth-token')).toBeNull();
  expect(sessionStorage.getItem('auth-user')).toBeNull();
  expect(sessionStorage.getItem('auth-refresh-token')).toBeNull();
  expect(window.location.reload).toHaveBeenCalled();
};

describe('sign-in keeps the refresh token', () => {
  it('stores the Cognito refresh token in sessionStorage only', async () => {
    const token = idToken(3600);
    cognito = () => json(200, { AuthenticationResult: { IdToken: token, AccessToken: 'access', RefreshToken: REFRESH } });
    await signInWithCognitoCredentials('user@example.com', 'pw-for-test'); // pragma: allowlist secret
    expect(sessionStorage.getItem('auth-token')).toBe(token);
    expect(sessionStorage.getItem('auth-refresh-token')).toBe(REFRESH);
    expect(Object.keys(localStorage)).toHaveLength(0);
  });
});

describe('refresh before expiry', () => {
  it('refreshes an ID token that is about to expire before the API call goes out', async () => {
    const old = signedIn(60);
    const fresh = idToken(3600);
    cognito = refreshesTo(fresh);

    const res = await apiCall('/workstations', { headers: { Authorization: `Bearer ${old}` } });

    expect(res.status).toBe(200);
    expect(cognitoCalls('InitiateAuth')).toHaveLength(1);
    expect(apiCalls().map(c => bearer(c.init))).toEqual([fresh]);
    expect(sessionStorage.getItem('auth-token')).toBe(fresh);
    expect(sessionStorage.getItem('auth-refresh-token')).toBe(REFRESH);
  });

  it('refreshes an expired ID token on page load instead of signing out', async () => {
    signedIn(-600);
    const fresh = idToken(3600);
    cognito = refreshesTo(fresh);
    expect(getAuthToken()).not.toBeNull(); // still refreshable
    await expect(getFreshAuthToken()).resolves.toBe(fresh);
  });

  it('refreshes in the background 5 minutes before expiry', async () => {
    vi.useFakeTimers();
    signedIn(10 * 60);
    const fresh = idToken(3600);
    cognito = refreshesTo(fresh);

    startTokenRefresh();
    await vi.advanceTimersByTimeAsync(4 * 60 * 1000);
    expect(cognitoCalls('InitiateAuth')).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(61 * 1000);
    expect(cognitoCalls('InitiateAuth')).toHaveLength(1);
    expect(sessionStorage.getItem('auth-token')).toBe(fresh);
  });

  it('retries a background refresh after a network error while the token is still valid', async () => {
    vi.useFakeTimers();
    signedIn(6 * 60);
    const fresh = idToken(3600);
    let attempts = 0;
    cognito = (url, init) => {
      attempts += 1;
      if (attempts === 1) throw new TypeError('Failed to fetch');
      return refreshesTo(fresh)(url, init);
    };
    startTokenRefresh();
    await vi.advanceTimersByTimeAsync(61 * 1000);
    expect(attempts).toBe(1);
    expect(sessionStorage.getItem('auth-refresh-token')).toBe(REFRESH);
    await vi.advanceTimersByTimeAsync(61 * 1000);
    expect(attempts).toBe(2);
    expect(sessionStorage.getItem('auth-token')).toBe(fresh);
  });
});

describe('refresh timing uses the token lifetime, not the local clock', () => {
  /** A Cognito-style ID token issued at `iat` (server clock) for `lifetime` seconds. */
  const serverToken = (iat: number, lifetime: number) => {
    serial += 1;
    const header = btoa(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
    const body = btoa(JSON.stringify({ iat, exp: iat + lifetime, email: 'user@example.com', marker: `t-${serial}` }));
    return `${header}.${body}.sig-${serial}`;
  };
  const refreshes = () => calls.filter(c => c.url === COGNITO && JSON.parse(String(c.init.body)).AuthFlow === 'REFRESH_TOKEN_AUTH');

  /** Cognito: sign-in and each refresh return a token of `lifetime` seconds, stamped by `serverNow()`. */
  const cognitoIssuing = (lifetime: number, serverNow: () => number): Handler => (_url, init) => {
    const body = JSON.parse(String(init.body));
    const auth = { IdToken: serverToken(serverNow(), lifetime), AccessToken: 'access' };
    return json(200, { AuthenticationResult: body.AuthFlow === 'USER_PASSWORD_AUTH' ? { ...auth, RefreshToken: REFRESH } : auth });
  };

  it('with the local clock 56 minutes fast, refreshes once and schedules the next 55 minutes later', async () => {
    vi.useFakeTimers();
    const serverStart = now();
    cognito = cognitoIssuing(3600, () => serverStart + 60); // the server's clock barely moves
    await signInWithCognitoCredentials('user@example.com', 'pw-for-test'); // pragma: allowlist secret

    vi.setSystemTime(Date.now() + 56 * 60 * 1000);
    const token = sessionStorage.getItem('auth-token')!;
    await apiCall('/workstations', { headers: { Authorization: `Bearer ${token}` } });
    expect(refreshes()).toHaveLength(1);

    await vi.advanceTimersByTimeAsync(5 * 60 * 1000);
    expect(refreshes()).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(49 * 60 * 1000); // 54 minutes after the refresh
    expect(refreshes()).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(2 * 60 * 1000); // 56 minutes after it
    expect(refreshes()).toHaveLength(2);
  });

  it('does not loop with a 5-minute ID token lifetime (refreshes at half its lifetime)', async () => {
    vi.useFakeTimers();
    cognito = cognitoIssuing(300, () => now());
    await signInWithCognitoCredentials('user@example.com', 'pw-for-test'); // pragma: allowlist secret
    await vi.advanceTimersByTimeAsync(10 * 60 * 1000);
    expect(refreshes()).toHaveLength(4); // at 150, 300, 450 and 600 s
  });

  it('starts at most one background or proactive refresh per 60 seconds', async () => {
    vi.useFakeTimers();
    cognito = cognitoIssuing(20, () => now()); // margin 10 s, below the floor
    await signInWithCognitoCredentials('user@example.com', 'pw-for-test'); // pragma: allowlist secret
    await vi.advanceTimersByTimeAsync(15 * 1000);
    expect(refreshes()).toHaveLength(1);

    // The token is due again, but the floor holds: these calls use it as it is.
    const token = sessionStorage.getItem('auth-token')!;
    await Promise.all(['/a', '/b', '/c'].map(p => apiCall(p, { headers: { Authorization: `Bearer ${token}` } })));
    expect(refreshes()).toHaveLength(1);
    expect(apiCalls().map(c => bearer(c.init))).toEqual([token, token, token]);

    await vi.advanceTimersByTimeAsync(10 * 60 * 1000);
    expect(refreshes().length).toBeLessThanOrEqual(11);
  });
});

describe('base64url tokens', () => {
  it("reads the expiry of a token whose payload has '-' or '_' and doesn't refresh it early", async () => {
    // Real Cognito tokens are base64url; this payload encodes to '/' and '+',
    // which base64url writes as '_' and '-'.
    const header = btoa(JSON.stringify({ alg: 'RS256' }));
    const body = btoa(JSON.stringify({ exp: now() + 3600, name: '\u00ff\u00ff\u00ff\u00fe\u00fe' }))
      .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
    expect(body).toMatch(/[-_]/);
    const token = `${header}.${body}.sig`;
    sessionStorage.setItem('auth-token', token);
    sessionStorage.setItem('auth-refresh-token', REFRESH);
    expect(getAuthToken()).toBe(token);
    await apiCall('/workstations', { headers: { Authorization: `Bearer ${token}` } });
    expect(cognitoCalls('InitiateAuth')).toHaveLength(0);
    expect(apiCalls().map(c => bearer(c.init))).toEqual([token]);
  });
});

describe('refresh on 401', () => {
  it('refreshes once and retries the request when the API answers 401', async () => {
    const old = signedIn(3600);
    const fresh = idToken(3600);
    cognito = refreshesTo(fresh);
    api = (_url, init) => (bearer(init) === fresh ? json(200, { ok: true }) : json(401, { message: 'Unauthorized' }));

    const res = await apiCall('/workstations', { method: 'GET', headers: { Authorization: `Bearer ${old}` } });

    expect(res.status).toBe(200);
    expect(cognitoCalls('InitiateAuth')).toHaveLength(1);
    expect(apiCalls().map(c => bearer(c.init))).toEqual([old, fresh]);
    expect(window.location.reload).not.toHaveBeenCalled();
  });

  it('signs out when the retried request is refused too', async () => {
    const old = signedIn(3600);
    cognito = refreshesTo(idToken(3600));
    api = () => json(401, { message: 'Unauthorized' });
    await apiCall('/workstations', { headers: { Authorization: `Bearer ${old}` } });
    expect(apiCalls()).toHaveLength(2);
    expectSignedOut();
  });

  it('keeps the old behaviour without a refresh token (LDAP sign-in)', async () => {
    sessionStorage.setItem('auth-token', idToken(3600));
    sessionStorage.setItem('auth-user', JSON.stringify({ username: 'ldap-user' }));
    api = () => json(401, {});
    await apiCall('/workstations', { headers: { Authorization: 'Bearer x' } });
    expect(cognitoCalls('InitiateAuth')).toHaveLength(0);
    expect(apiCalls()).toHaveLength(1);
    expect(window.location.reload).toHaveBeenCalledOnce();
  });
});

describe('concurrent calls during a refresh', () => {
  it('refreshes once for several calls with an expiring token, and sends each with the new token', async () => {
    const old = signedIn(30);
    const fresh = idToken(3600);
    let release!: () => void;
    const gate = new Promise<void>(r => { release = r; });
    cognito = async (url, init) => { await gate; return refreshesTo(fresh)(url, init); };

    const pending = ['/a', '/b', '/c'].map(p => apiCall(p, { headers: { Authorization: `Bearer ${old}` } }));
    await Promise.resolve();
    release();
    const results = await Promise.all(pending);

    expect(results.map(r => r.status)).toEqual([200, 200, 200]);
    expect(cognitoCalls('InitiateAuth')).toHaveLength(1);
    expect(apiCalls().map(c => bearer(c.init))).toEqual([fresh, fresh, fresh]);
  });

  it('refreshes once when several calls get 401 at the same time', async () => {
    const old = signedIn(3600);
    const fresh = idToken(3600);
    cognito = refreshesTo(fresh);
    api = (_url, init) => (bearer(init) === fresh ? json(200, {}) : json(401, {}));

    const results = await Promise.all(['/a', '/b', '/c'].map(p => apiCall(p, { headers: { Authorization: `Bearer ${old}` } })));

    expect(results.map(r => r.status)).toEqual([200, 200, 200]);
    expect(cognitoCalls('InitiateAuth')).toHaveLength(1);
    expect(apiCalls().filter(c => bearer(c.init) === fresh)).toHaveLength(3);
  });

  it('shares one Cognito request between direct refreshSession calls', async () => {
    signedIn(3600);
    const fresh = idToken(3600);
    cognito = refreshesTo(fresh);
    const tokens = await Promise.all([refreshSession(), refreshSession(), refreshSession()]);
    expect(tokens).toEqual([fresh, fresh, fresh]);
    expect(cognitoCalls('InitiateAuth')).toHaveLength(1);
  });
});

describe('a failed refresh signs the user out', () => {
  it('clears every token and reloads when Cognito refuses the refresh token on an API call', async () => {
    const old = signedIn(30);
    cognito = refused;
    const res = await apiCall('/workstations', { headers: { Authorization: `Bearer ${old}` } });
    expect(res.status).toBe(401);
    expect(apiCalls()).toHaveLength(0);
    expectSignedOut();
  });

  it('clears every token and reloads when a background refresh is refused', async () => {
    vi.useFakeTimers();
    signedIn(5 * 60 + 1);
    cognito = refused;
    startTokenRefresh();
    await vi.advanceTimersByTimeAsync(2 * 1000);
    expectSignedOut();
  });

  it('clears every token after a 401 whose refresh is refused', async () => {
    const old = signedIn(3600);
    cognito = refused;
    api = () => json(401, {});
    await apiCall('/workstations', { headers: { Authorization: `Bearer ${old}` } });
    expectSignedOut();
  });
});

describe('sign-out', () => {
  it('clears every token and revokes the refresh token', async () => {
    signedIn(3600);
    cognito = () => json(200, {});
    await signOut(true);
    expect(sessionStorage.getItem('auth-token')).toBeNull();
    expect(sessionStorage.getItem('auth-user')).toBeNull();
    expect(sessionStorage.getItem('auth-refresh-token')).toBeNull();
    const revoke = cognitoCalls('RevokeToken');
    expect(revoke).toHaveLength(1);
    expect(JSON.parse(String(revoke[0].init.body))).toEqual({ Token: REFRESH, ClientId: 'test-client-id' });
  });

  it('still signs out when the revoke call fails', async () => {
    signedIn(3600);
    cognito = () => { throw new TypeError('Failed to fetch'); };
    await signOut(false);
    expect(sessionStorage.getItem('auth-refresh-token')).toBeNull();
  });
});

describe('tokens never reach the console', () => {
  it('logs no ID or refresh token across refresh, retry, refusal and sign-out', async () => {
    const old = signedIn(30);
    const fresh = idToken(3600);
    cognito = refreshesTo(fresh);
    api = (_url, init) => (bearer(init) === fresh ? json(200, {}) : json(401, {}));
    await apiCall('/a', { headers: { Authorization: `Bearer ${old}` } });
    cognito = refused;
    api = () => json(401, {});
    await apiCall('/b', { headers: { Authorization: `Bearer ${fresh}` } });
    signedIn(3600);
    cognito = () => { throw new TypeError('Failed to fetch'); };
    await signOut(false);

    expect(logged.length).toBeGreaterThan(0); // the refusal and the revoke failure are logged
    const secrets = [REFRESH, old, fresh, old.split('.')[1], fresh.split('.')[1]];
    for (const line of logged) {
      for (const secret of secrets) expect(line).not.toContain(secret);
    }
  });
});
