// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * AD session refresh in the ldap-auth Lambda (POST /auth/ldap/refresh, #85).
 * The current MRM token must verify (exact HS256 header, HMAC, unexpired, an
 * auth_time within the 12-hour cap), the user must still exist and be enabled
 * in AD, and the new token carries the admin status AD has now. ldapjs and
 * the AWS SDK clients are mocked.
 */

import * as crypto from 'crypto';

const SIGNING_KEY = 'test-signing-key-for-refresh'; // pragma: allowlist secret
const SERVICE_PASSWORD = 'svc-test-pw'; // pragma: allowlist secret
const USERNAME = 'jdoe';
const ADMIN_GROUP_DN = 'CN=MRM-Admins,OU=Groups,DC=example,DC=internal';

const mockState: {
  // AD record returned for the user: null = not found
  user: Record<string, unknown> | null;
  bindError: boolean;
  binds: Array<{ dn: string; password: unknown }>;
  filters: string[];
} = { user: null, bindError: false, binds: [], filters: [] };

jest.mock('ldapjs', () => ({
  createClient: () => ({
    bind: (dn: string, password: unknown, cb: (err: Error | null) => void) => {
      mockState.binds.push({ dn, password });
      cb(mockState.bindError ? new Error('InvalidCredentialsError') : null);
    },
    search: (_base: string, opts: { filter: string }, cb: (err: Error | null, res: unknown) => void) => {
      mockState.filters.push(opts.filter);
      const handlers: Record<string, (arg?: unknown) => void> = {};
      const res = { on: (name: string, fn: (arg?: unknown) => void) => { handlers[name] = fn; } };
      cb(null, res);
      if (mockState.user) handlers.searchEntry?.({ object: mockState.user });
      handlers.end?.();
    },
    unbind: () => undefined,
    on: () => undefined,
  }),
}), { virtual: true });

jest.mock('@aws-sdk/client-ssm', () => ({
  SSMClient: jest.fn().mockImplementation(() => ({
    send: jest.fn().mockResolvedValue({ Parameter: { Value: 'example.internal' } }),
  })),
  GetParameterCommand: jest.fn(),
}), { virtual: true });

jest.mock('@aws-sdk/client-secrets-manager', () => ({
  SecretsManagerClient: jest.fn().mockImplementation(() => ({
    send: jest.fn(async (cmd: { input: { SecretId: string } }) => {
      if (cmd.input.SecretId === 'arn:aws:secretsmanager:us-east-1:123456789012:secret:svc') { // pragma: allowlist secret
        return { SecretString: JSON.stringify({ username: 'ResourceAdmin', password: SERVICE_PASSWORD }) };
      }
      return { SecretString: SIGNING_KEY };
    }),
  })),
  GetSecretValueCommand: jest.fn().mockImplementation((input: unknown) => ({ input })),
}), { virtual: true });

jest.mock('@aws-sdk/client-lambda', () => ({
  LambdaClient: jest.fn().mockImplementation(() => ({ send: jest.fn() })),
  InvokeCommand: jest.fn(),
}), { virtual: true });
jest.mock('@aws-sdk/client-dynamodb', () => ({ DynamoDBClient: jest.fn().mockImplementation(() => ({})) }), { virtual: true });
jest.mock('@aws-sdk/lib-dynamodb', () => ({
  DynamoDBDocumentClient: { from: () => ({ send: jest.fn().mockResolvedValue({}) }) },
  UpdateCommand: jest.fn(),
}), { virtual: true });

// eslint-disable-next-line @typescript-eslint/no-var-requires
const ldapAuth = require('../lambda/ldap-auth/index.js');

const now = () => Math.floor(Date.now() / 1000);
const b64 = (v: unknown) => Buffer.from(typeof v === 'string' ? v : JSON.stringify(v)).toString('base64url');
const hmac = (data: string, key = SIGNING_KEY) => crypto.createHmac('sha256', key).update(data).digest('base64url');

function sign(claims: Record<string, unknown>, header: Record<string, unknown> = { alg: 'HS256', typ: 'JWT' }, key = SIGNING_KEY) {
  const h = b64(header);
  const p = b64(claims);
  return `${h}.${p}.${hmac(`${h}.${p}`, key)}`;
}

const claims = (over: Record<string, unknown> = {}) => ({
  username: USERNAME,
  email: 'jdoe@example.internal',
  given_name: 'Jane',
  family_name: 'Doe',
  isAdmin: false,
  iat: now() - 3000,
  auth_time: now() - 3000,
  exp: now() + 600,
  ...over,
});

const decode = (token: string) => JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString());

async function refresh(token: string | null) {
  const res = await ldapAuth.handler({
    resource: '/auth/ldap/refresh',
    path: '/auth/ldap/refresh',
    httpMethod: 'POST',
    headers: token === null ? {} : { Authorization: `Bearer ${token}` },
    body: null,
  });
  return { statusCode: res.statusCode, body: JSON.parse(res.body) };
}

const enabledUser = (over: Record<string, unknown> = {}) => ({
  sAMAccountName: USERNAME,
  userAccountControl: '512',
  accountExpires: '9223372036854775807',
  mail: 'jdoe@example.internal',
  givenName: 'Jane',
  sn: 'Doe',
  memberOf: ['CN=Editors,OU=Groups,DC=example,DC=internal'],
  ...over,
});

let logged: string[];

beforeEach(() => {
  mockState.user = enabledUser();
  mockState.bindError = false;
  mockState.binds = [];
  mockState.filters = [];
  logged = [];
  for (const level of ['log', 'info', 'warn', 'error'] as const) {
    jest.spyOn(console, level).mockImplementation((...args: unknown[]) => {
      logged.push(args.map(a => (typeof a === 'string' ? a : JSON.stringify(a))).join(' '));
    });
  }
  process.env.JWT_SECRET_ARN = 'arn:aws:secretsmanager:us-east-1:123456789012:secret:jwt'; // pragma: allowlist secret
  process.env.AD_SERVICE_ACCOUNT_SECRET_ARN = 'arn:aws:secretsmanager:us-east-1:123456789012:secret:svc'; // pragma: allowlist secret
  process.env.PASCAL_CASE_NAME = 'MediaResourceManager';
  process.env.ADMIN_GROUP_NAME = 'MRM-Admins';
});

afterEach(() => {
  jest.restoreAllMocks();
});

describe('POST /auth/ldap/refresh: success', () => {
  test('issues a new 1-hour HS256 token that keeps auth_time', async () => {
    const before = claims();
    const r = await refresh(sign(before));
    expect(r.statusCode).toBe(200);
    const [h, p, s] = r.body.token.split('.');
    expect(JSON.parse(Buffer.from(h, 'base64url').toString())).toEqual({ alg: 'HS256', typ: 'JWT' });
    expect(s).toBe(hmac(`${h}.${p}`));
    const c = decode(r.body.token);
    expect(c.username).toBe(USERNAME);
    expect(c.auth_time).toBe(before.auth_time);
    expect(c.iat).toBeGreaterThanOrEqual(now() - 1);
    expect(c.exp).toBe(c.iat + 3600);
  });

  test('looks the user up with the service account, not a user password', async () => {
    await refresh(sign(claims()));
    expect(mockState.binds).toEqual([{ dn: 'ResourceAdmin@example.internal', password: SERVICE_PASSWORD }]);
    expect(mockState.filters).toEqual(['(&(objectClass=user)(sAMAccountName=jdoe))']);
  });

  test('picks up a change in admin group membership', async () => {
    mockState.user = enabledUser({ memberOf: ['CN=Editors,OU=Groups,DC=example,DC=internal', ADMIN_GROUP_DN] });
    const promoted = await refresh(sign(claims({ isAdmin: false })));
    expect(decode(promoted.body.token).isAdmin).toBe(true);

    mockState.user = enabledUser({ memberOf: [] });
    const demoted = await refresh(sign(claims({ isAdmin: true })));
    expect(decode(demoted.body.token).isAdmin).toBe(false);
  });

  test('ends the new token at the 12-hour cap when that comes first', async () => {
    const authTime = now() - (12 * 3600 - 1200);
    const r = await refresh(sign(claims({ auth_time: authTime, iat: now() - 600, exp: now() + 300 })));
    expect(r.statusCode).toBe(200);
    expect(decode(r.body.token).exp).toBe(authTime + ldapAuth.SESSION_MAX_SECONDS);
  });

  test('sign-in stamps auth_time = iat on new tokens', async () => {
    // Re-uses the sign-in path with the mocked bind: the mock accepts any
    // bind, so this checks only the token claims. Sign-in arms a 15 s
    // timeout it never clears, so this test runs on fake timers.
    jest.useFakeTimers({ now: Date.now() });
    try {
      const res = await ldapAuth.handler({ httpMethod: 'POST', body: JSON.stringify({ username: USERNAME, password: 'user-pw' }) }); // pragma: allowlist secret
      expect(res.statusCode).toBe(200);
      const c = decode(JSON.parse(res.body).token);
      expect(c.auth_time).toBe(c.iat);
      expect(c.exp).toBe(c.iat + 3600);
    } finally {
      jest.clearAllTimers();
      jest.useRealTimers();
    }
  });
});

describe('POST /auth/ldap/refresh: tokens that are refused', () => {
  const refusedCases: Array<[string, () => string]> = [
    ['an expired token', () => sign(claims({ exp: now() - 1 }))],
    ['a token signed with another key', () => sign(claims(), undefined, 'some-other-key')],
    ['a token with a changed payload', () => {
      const [h, , s] = sign(claims()).split('.');
      return `${h}.${b64(claims({ isAdmin: true }))}.${s}`;
    }],
    ['alg:none with an empty signature', () => `${b64({ alg: 'none', typ: 'JWT' })}.${b64(claims())}.`],
    ['alg:none with a valid HMAC', () => sign(claims(), { alg: 'none', typ: 'JWT' })],
    ['an RS256 header with an HMAC made with the shared key (HS/RS confusion)', () => sign(claims(), { alg: 'RS256', typ: 'JWT' })],
    ['an HS512 header', () => sign(claims(), { alg: 'HS512', typ: 'JWT' })],
    ['a header with extra fields', () => sign(claims(), { alg: 'HS256', typ: 'JWT', kid: '../../etc/passwd' })],
    ['a token without auth_time (issued before this change)', () => {
      const c: Record<string, unknown> = claims();
      delete c.auth_time;
      return sign(c);
    }],
    ['a session past the 12-hour cap', () => sign(claims({ auth_time: now() - 12 * 3600 - 1, iat: now() - 3000 }))],
    ['a token that already lasts until the cap', () => {
      const authTime = now() - 11 * 3600;
      return sign(claims({ auth_time: authTime, iat: now() - 60, exp: authTime + 12 * 3600 }))
    }],
    ['an auth_time in the future', () => sign(claims({ auth_time: now() + 3600 }))],
    ['a username AD would not allow', () => sign(claims({ username: 'jdoe)(cn=*' }))],
    ['a non-string username', () => sign(claims({ username: ['jdoe'] }))],
    ['two segments only', () => sign(claims()).split('.').slice(0, 2).join('.')],
  ];

  test.each(refusedCases)('refuses %s with 401 and no directory lookup', async (_name, make) => {
    const r = await refresh(make());
    expect(r.statusCode).toBe(401);
    expect(r.body.token).toBeUndefined();
    expect(mockState.binds).toHaveLength(0);
  });

  test('refuses a request without a bearer token', async () => {
    const r = await refresh(null);
    expect(r.statusCode).toBe(401);
  });

  test('refuses a Cognito-style RS256 token', async () => {
    const r = await refresh(`${b64({ alg: 'RS256', kid: 'abc' })}.${b64({ iss: 'https://cognito-idp.us-east-1.amazonaws.com/pool', exp: now() + 600 })}.c2ln`);
    expect(r.statusCode).toBe(401);
  });
});

describe('POST /auth/ldap/refresh: the AD account decides', () => {
  test.each<[string, Record<string, unknown> | null]>([
    ['a deleted user', null],
    ['a disabled user', enabledUser({ userAccountControl: '514' })],
    ['a user without a readable userAccountControl', enabledUser({ userAccountControl: undefined })],
    ['an expired account', enabledUser({ accountExpires: String((BigInt(now() - 60) + 11644473600n) * 10000000n) })],
  ])('refuses %s with 401', async (_name, user) => {
    mockState.user = user;
    const r = await refresh(sign(claims()));
    expect(r.statusCode).toBe(401);
    expect(r.body.token).toBeUndefined();
  });

  test('accepts an account that expires later', async () => {
    mockState.user = enabledUser({ accountExpires: String((BigInt(now() + 86400) + 11644473600n) * 10000000n) });
    const r = await refresh(sign(claims()));
    expect(r.statusCode).toBe(200);
  });

  test('answers 503 when the directory cannot be queried, and issues no token', async () => {
    mockState.bindError = true;
    const r = await refresh(sign(claims()));
    expect(r.statusCode).toBe(503);
    expect(r.body.token).toBeUndefined();
  });
});

describe('logging', () => {
  test('logs no token, username or password for success, refusal and directory errors', async () => {
    const valid = sign(claims());
    const ok = await refresh(valid);
    await refresh(sign(claims({ exp: now() - 1 })));
    mockState.user = enabledUser({ userAccountControl: '514' });
    await refresh(sign(claims()));
    mockState.bindError = true;
    await refresh(sign(claims()));

    expect(logged.some(l => l.includes('refused'))).toBe(true);
    const secrets = [USERNAME, valid, ok.body.token, valid.split('.')[1], valid.split('.')[2], SERVICE_PASSWORD, SIGNING_KEY];
    for (const line of logged) {
      for (const s of secrets) expect(line).not.toContain(s);
    }
  });
});
