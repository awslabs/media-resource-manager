// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Unit tests for the shared authz helper module. The helper is copied
 * byte-identical into every affected Lambda handler directory; we exercise
 * one canonical copy here (lambda/user-group-manager/authz.js) and rely on
 * the md5 invariant enforced in commit history to ensure every other copy
 * behaves the same way.
 *
 * See H1-3966572 / GHSA-58q4-fcw9-2778 / SIM P498186948.
 */

// eslint-disable-next-line @typescript-eslint/no-var-requires
const authz = require('../lambda/user-group-manager/authz.js');
const { getCallerIdentity, requireAdmin, requireSelfOrAdmin, forbidden, unauthorized } = authz;

// Minimal event shape helpers. API Gateway serialises the authorizer
// context to strings, so `isAdmin` arrives as 'true' / 'false' rather than
// a boolean — the helpers must accept both.
function eventFor(context: Record<string, unknown> | null): unknown {
  if (context === null) {
    return {};
  }
  return { requestContext: { authorizer: context } };
}

describe('getCallerIdentity', () => {
  it('returns default identity when authorizer context is absent', () => {
    const identity = getCallerIdentity({});
    expect(identity).toEqual({
      username: null,
      isAdmin: false,
      email: null,
      tokenType: null
    });
  });

  it('treats the string "true" as admin (API Gateway serialisation)', () => {
    const identity = getCallerIdentity(eventFor({ isAdmin: 'true', username: 'alice' }));
    expect(identity.isAdmin).toBe(true);
    expect(identity.username).toBe('alice');
  });

  it('treats a real boolean true as admin (direct invoke)', () => {
    const identity = getCallerIdentity(eventFor({ isAdmin: true, username: 'alice' }));
    expect(identity.isAdmin).toBe(true);
  });

  it('treats the string "false" as non-admin', () => {
    const identity = getCallerIdentity(eventFor({ isAdmin: 'false', username: 'bob' }));
    expect(identity.isAdmin).toBe(false);
  });

  it('falls back to userId when username is missing', () => {
    const identity = getCallerIdentity(eventFor({ userId: 'carol@example.com' }));
    expect(identity.username).toBe('carol@example.com');
  });

  it('passes through email and tokenType', () => {
    const identity = getCallerIdentity(eventFor({
      isAdmin: 'true',
      username: 'dave',
      email: 'dave@example.com',
      tokenType: 'ldap'
    }));
    expect(identity.email).toBe('dave@example.com');
    expect(identity.tokenType).toBe('ldap');
  });
});

describe('forbidden', () => {
  it('returns a 403 with the given reason and CORS headers', () => {
    const response = forbidden('nope');
    expect(response.statusCode).toBe(403);
    expect(JSON.parse(response.body)).toEqual({ error: 'nope' });
    expect(response.headers['Access-Control-Allow-Origin']).toBe('*');
    expect(response.headers['Content-Type']).toBe('application/json');
  });
});

describe('unauthorized', () => {
  it('returns a 401 with the given reason and CORS headers', () => {
    const response = unauthorized('missing token');
    expect(response.statusCode).toBe(401);
    expect(JSON.parse(response.body)).toEqual({ error: 'missing token' });
    expect(response.headers['Access-Control-Allow-Origin']).toBe('*');
  });
});

describe('requireAdmin', () => {
  it('returns null when the caller is admin (string "true")', () => {
    expect(requireAdmin(eventFor({ isAdmin: 'true', username: 'alice' }))).toBeNull();
  });

  it('returns null when the caller is admin (boolean true)', () => {
    expect(requireAdmin(eventFor({ isAdmin: true, username: 'alice' }))).toBeNull();
  });

  it('returns a 403 when the caller is a non-admin user', () => {
    const response = requireAdmin(eventFor({ isAdmin: 'false', username: 'bob' }));
    expect(response).not.toBeNull();
    expect(response.statusCode).toBe(403);
    expect(JSON.parse(response.body).error).toMatch(/Administrator privileges required/i);
  });

  it('returns a 403 when the authorizer context is missing entirely', () => {
    const response = requireAdmin({});
    expect(response).not.toBeNull();
    expect(response.statusCode).toBe(403);
  });

  it('rejects the string "1" — only exact "true" or boolean true counts', () => {
    const response = requireAdmin(eventFor({ isAdmin: '1', username: 'mallory' }));
    expect(response).not.toBeNull();
    expect(response.statusCode).toBe(403);
  });
});

describe('requireSelfOrAdmin', () => {
  it('returns null when the caller is admin, regardless of target', () => {
    expect(
      requireSelfOrAdmin(eventFor({ isAdmin: 'true', username: 'root' }), 'someone-else')
    ).toBeNull();
  });

  it('returns null when the caller matches the target username exactly', () => {
    expect(
      requireSelfOrAdmin(eventFor({ isAdmin: 'false', username: 'alice' }), 'alice')
    ).toBeNull();
  });

  it('returns a 403 when the caller is trying to act on another user', () => {
    const response = requireSelfOrAdmin(
      eventFor({ isAdmin: 'false', username: 'alice' }),
      'bob'
    );
    expect(response).not.toBeNull();
    expect(response.statusCode).toBe(403);
    expect(JSON.parse(response.body).error).toMatch(/only modify your own account/i);
  });

  it('returns a 403 when authorizer context is missing', () => {
    const response = requireSelfOrAdmin({}, 'alice');
    expect(response).not.toBeNull();
    expect(response.statusCode).toBe(403);
  });

  it('returns a 403 when the target is null and the caller is not admin', () => {
    // Guards against a mistakenly-null assignedUserId letting a non-admin
    // through (e.g., unassigned workstation lifecycle actions).
    const response = requireSelfOrAdmin(
      eventFor({ isAdmin: 'false', username: 'alice' }),
      null
    );
    expect(response).not.toBeNull();
    expect(response.statusCode).toBe(403);
  });

  it('does string comparison — usernames are case-sensitive', () => {
    // Matches the behaviour of the JWT authorizer, which stamps the
    // authenticated userId verbatim into event.requestContext.authorizer.
    const response = requireSelfOrAdmin(
      eventFor({ isAdmin: 'false', username: 'Alice' }),
      'alice'
    );
    expect(response).not.toBeNull();
    expect(response.statusCode).toBe(403);
  });
});
