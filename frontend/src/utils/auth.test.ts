// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Unit tests for frontend auth utilities.
 *
 * These exercise the pure/deterministic parts of frontend/src/utils/auth.ts:
 * token parsing, expiry validation, session storage handling, and error
 * classification. Anything that hits a real network or redirects the browser
 * is covered by the Playwright e2e suite, not here.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  getAuthToken,
  getAuthHeaders,
  getCurrentUser,
  handleAuthError,
} from './auth';

/** Build a JWT-shaped string with the given payload (no real signature). */
function makeJwt(payload: Record<string, unknown>): string {
  const header = btoa(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const body = btoa(JSON.stringify(payload));
  const signature = 'fake-signature-not-verified-client-side';
  return `${header}.${body}.${signature}`;
}

const HOUR = 3600;
const now = () => Math.floor(Date.now() / 1000);

describe('getAuthToken', () => {
  beforeEach(() => {
    sessionStorage.clear();
    // Suppress the "Invalid token detected, clearing session" console.log
    // that fires in the malformed-payload branch.
    vi.spyOn(console, 'log').mockImplementation(() => {});
  });

  it('returns null when no token is stored', () => {
    expect(getAuthToken()).toBeNull();
  });

  it('returns null when the stored token is malformed (not three parts)', () => {
    sessionStorage.setItem('auth-token', 'not.a.valid.jwt.string');
    expect(getAuthToken()).toBeNull();
  });

  it('returns null when the stored token has a non-decodable payload', () => {
    sessionStorage.setItem('auth-token', 'aaa.not-base64.bbb');
    expect(getAuthToken()).toBeNull();
  });

  it('clears both auth-token and auth-user when the payload cannot be decoded', () => {
    sessionStorage.setItem('auth-token', 'aaa.not-base64.bbb');
    sessionStorage.setItem('auth-user', JSON.stringify({ email: 'a@b.c' }));

    getAuthToken();

    expect(sessionStorage.getItem('auth-token')).toBeNull();
    expect(sessionStorage.getItem('auth-user')).toBeNull();
  });

  it('returns null when the token has expired', () => {
    const expired = makeJwt({ exp: now() - HOUR });
    sessionStorage.setItem('auth-token', expired);
    expect(getAuthToken()).toBeNull();
  });

  it('returns null when the token has no exp claim', () => {
    const noExp = makeJwt({ sub: 'user-1' });
    sessionStorage.setItem('auth-token', noExp);
    expect(getAuthToken()).toBeNull();
  });

  it('returns the token when it is valid and unexpired', () => {
    const valid = makeJwt({ exp: now() + HOUR, sub: 'user-1' });
    sessionStorage.setItem('auth-token', valid);
    expect(getAuthToken()).toBe(valid);
  });

  it('does NOT clear the session when the token is merely expired', () => {
    // Only malformed tokens should trigger a session wipe. An expired
    // token is a normal end-of-session state — the caller (typically the
    // API layer) decides how to handle "no auth" from there.
    const expired = makeJwt({ exp: now() - HOUR });
    sessionStorage.setItem('auth-token', expired);
    sessionStorage.setItem('auth-user', JSON.stringify({ email: 'a@b.c' }));

    getAuthToken();

    expect(sessionStorage.getItem('auth-token')).toBe(expired);
    expect(sessionStorage.getItem('auth-user')).not.toBeNull();
  });
});

describe('getAuthHeaders', () => {
  beforeEach(() => {
    sessionStorage.clear();
    vi.spyOn(console, 'log').mockImplementation(() => {});
  });

  it('returns an empty object when there is no valid token', () => {
    expect(getAuthHeaders()).toEqual({});
  });

  it('returns an Authorization: Bearer header for a valid token', () => {
    const token = makeJwt({ exp: now() + HOUR });
    sessionStorage.setItem('auth-token', token);

    expect(getAuthHeaders()).toEqual({
      Authorization: `Bearer ${token}`,
    });
  });

  it('returns an empty object for an expired token (not a stale bearer)', () => {
    // Regression: a stale token must not be sent as if valid — that would
    // let the frontend keep spamming a backend that has to re-verify.
    sessionStorage.setItem('auth-token', makeJwt({ exp: now() - 10 }));
    expect(getAuthHeaders()).toEqual({});
  });
});

describe('getCurrentUser', () => {
  beforeEach(() => sessionStorage.clear());

  it('returns null when no user is stored', () => {
    expect(getCurrentUser()).toBeNull();
  });

  it('returns the parsed user object when one is stored', () => {
    const user = {
      email: 'user@example.com',
      firstName: 'Test',
      lastName: 'User',
      isAdmin: false,
      groups: ['MRM-Users'],
    };
    sessionStorage.setItem('auth-user', JSON.stringify(user));
    expect(getCurrentUser()).toEqual(user);
  });
});

describe('handleAuthError', () => {
  beforeEach(() => {
    sessionStorage.clear();
    // Stub window.location.reload — getCurrentUser calls it inside
    // handleAuthError. jsdom has a real window, so we spy rather than mock
    // the whole object.
    vi.stubGlobal('location', { ...window.location, reload: vi.fn() });
  });

  it('returns true and clears session for message "No current user"', () => {
    sessionStorage.setItem('auth-token', 'anything');
    sessionStorage.setItem('auth-user', JSON.stringify({ email: 'a@b.c' }));

    const handled = handleAuthError({ message: 'No current user' });

    expect(handled).toBe(true);
    expect(sessionStorage.getItem('auth-token')).toBeNull();
    expect(sessionStorage.getItem('auth-user')).toBeNull();
    expect(window.location.reload).toHaveBeenCalledOnce();
  });

  it('returns true for messages that include "No current user"', () => {
    // The API layer wraps errors, so the substring match matters.
    const handled = handleAuthError({
      message: 'Auth failed: No current user found in session',
    });
    expect(handled).toBe(true);
  });

  it('returns false for unrelated errors and does NOT clear the session', () => {
    sessionStorage.setItem('auth-token', 'anything');
    sessionStorage.setItem('auth-user', JSON.stringify({ email: 'a@b.c' }));

    const handled = handleAuthError({ message: 'Something else went wrong' });

    expect(handled).toBe(false);
    expect(sessionStorage.getItem('auth-token')).toBe('anything');
    expect(sessionStorage.getItem('auth-user')).not.toBeNull();
    expect(window.location.reload).not.toHaveBeenCalled();
  });

  it('returns false when error has no message field (defensive)', () => {
    expect(handleAuthError({})).toBe(false);
    expect(handleAuthError(new Error(''))).toBe(false);
  });
});
