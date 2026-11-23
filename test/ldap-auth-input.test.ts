// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Input handling of the ldap-auth Lambda (POST /auth/ldap and the
 * change-password Lambda's direct invoke). ldapjs and the AWS SDK clients are
 * mocked: the tests check which requests reach the LDAP bind, what the caller
 * gets back, and that no log line carries the password.
 */

export {};

const PASSWORD = 'Correct-Horse-9-Battery'; // pragma: allowlist secret
const binds: Array<{ dn: string; password: unknown }> = [];

jest.mock('ldapjs', () => ({
  createClient: () => ({
    bind: (dn: string, password: unknown, cb: (err: Error | null) => void) => {
      binds.push({ dn, password });
      if (typeof password !== 'string') throw new TypeError('credentials (string) required');
      cb(password === PASSWORD ? null : new Error('InvalidCredentialsError'));
    },
    search: (_base: string, _opts: unknown, cb: (err: Error | null, res: unknown) => void) => {
      const handlers: Record<string, (arg?: unknown) => void> = {};
      const res = { on: (name: string, fn: (arg?: unknown) => void) => { handlers[name] = fn; } };
      cb(null, res);
      handlers.searchEntry?.({ object: { displayName: 'Test User', givenName: 'Test', sn: 'User', memberOf: [] } });
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
    send: jest.fn().mockResolvedValue({ SecretString: 'test-signing-key' }), // pragma: allowlist secret
  })),
  GetSecretValueCommand: jest.fn(),
}), { virtual: true });

jest.mock('@aws-sdk/client-lambda', () => ({
  LambdaClient: jest.fn().mockImplementation(() => ({ send: jest.fn() })),
  InvokeCommand: jest.fn(),
}), { virtual: true });

jest.mock('@aws-sdk/client-dynamodb', () => ({
  DynamoDBClient: jest.fn().mockImplementation(() => ({})),
}), { virtual: true });

jest.mock('@aws-sdk/lib-dynamodb', () => ({
  DynamoDBDocumentClient: { from: () => ({ send: jest.fn().mockResolvedValue({}) }) },
  UpdateCommand: jest.fn(),
}), { virtual: true });

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { handler } = require('../lambda/ldap-auth/index.js');

const logged: string[] = [];
const event = (body: unknown) => ({
  httpMethod: 'POST',
  body: typeof body === 'string' ? body : JSON.stringify(body),
});

beforeEach(() => {
  jest.useFakeTimers();
  binds.length = 0;
  logged.length = 0;
  for (const level of ['log', 'warn', 'error'] as const) {
    jest.spyOn(console, level).mockImplementation((...args: unknown[]) => {
      logged.push(args.map((a) => (typeof a === 'string' ? a : JSON.stringify(a))).join(' '));
    });
  }
  process.env.JWT_SECRET_ARN = 'arn:aws:secretsmanager:us-east-1:123456789012:secret:jwt'; // pragma: allowlist secret
  process.env.PASCAL_CASE_NAME = 'MediaResourceManager';
  process.env.USER_TABLE_NAME = 'mrm-users';
});

afterEach(() => {
  jest.clearAllTimers();
  jest.useRealTimers();
  jest.restoreAllMocks();
});

const expectGeneric400 = (res: { statusCode: number; body: string }) => {
  expect(res.statusCode).toBe(400);
  expect(JSON.parse(res.body)).toEqual({ error: 'Username and password required' });
  expect(binds).toHaveLength(0);
};

describe('ldap-auth input validation', () => {
  test('a malformed JSON body gets the generic 400', async () => {
    expectGeneric400(await handler(event('{"username": "alice", "password": ')));
  });

  test.each([
    ['an array body', [PASSWORD]],
    ['a JSON string body', JSON.stringify('alice')],
    ['a numeric username', { username: 12345, password: PASSWORD }],
    ['an object password', { username: 'alice', password: { value: PASSWORD } }],
    ['a boolean password', { username: 'alice', password: true }],
    ['an empty password', { username: 'alice', password: '' }],
    ['a missing username', { password: PASSWORD }],
    ['a username that is only a domain prefix', { username: 'EXAMPLE\\', password: PASSWORD }],
  ])('%s gets the generic 400', async (_name, body) => {
    expectGeneric400(await handler(event(body)));
  });

  test.each(['alice*', 'a"b', 'a/b', 'a[b]', 'a:b', 'a;b', 'a|b', 'a=b', 'a,b', 'a+b', 'a?b', 'a<b>', 'a\u0000b', 'a\nb', 'user@'])(
    'username %j with a character AD does not allow gets the generic 400',
    async (username) => {
      expectGeneric400(await handler(event({ username, password: PASSWORD })));
    },
  );

  test('overlong username and password get the generic 400', async () => {
    expectGeneric400(await handler(event({ username: 'a'.repeat(65), password: PASSWORD })));
    expectGeneric400(await handler(event({ username: 'a'.repeat(600), password: PASSWORD })));
    expectGeneric400(await handler(event({ username: 'alice', password: 'p'.repeat(1025) })));
  });

  test('a valid request binds once and returns a token', async () => {
    const res = await handler(event({ username: 'alice', password: PASSWORD }));
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toMatchObject({ success: true, username: 'alice' });
    expect(binds).toEqual([{ dn: 'alice@example.internal', password: PASSWORD }]);
  });

  test.each(['alice@example.internal', 'EXAMPLE\\alice', '  alice  '])(
    'username %j is normalised to the account name',
    async (username) => {
      const res = await handler(event({ username, password: PASSWORD }));
      expect(res.statusCode).toBe(200);
      expect(binds).toEqual([{ dn: 'alice@example.internal', password: PASSWORD }]);
    },
  );

  test('a wrong password still gets the generic 401', async () => {
    const res = await handler(event({ username: 'alice', password: 'wrong-password' })); // pragma: allowlist secret
    expect(res.statusCode).toBe(401);
    expect(JSON.parse(res.body)).toEqual({ error: 'Invalid credentials' });
  });

  test("the change-password Lambda's direct-invoke event still works", async () => {
    // Same shape as verifyCurrentPassword() in lambda/change-password/index.js.
    const res = await handler({ httpMethod: 'POST', body: JSON.stringify({ username: 'alice', password: PASSWORD }) });
    expect(res.statusCode).toBe(200);
  });

  test('no log line carries the password or the raw username', async () => {
    await handler(event({ username: 'EXAMPLE\\alice', password: PASSWORD }));
    await handler(event({ username: 'alice', password: 'wrong-password' })); // pragma: allowlist secret
    await handler(event({ username: `x@${PASSWORD}`, password: PASSWORD }));
    await handler(event('{"username": "alice", "password": '));
    expect(logged.length).toBeGreaterThan(0);
    for (const line of logged) {
      expect(line).not.toContain(PASSWORD);
      expect(line).not.toContain('wrong-password');
      expect(line).not.toContain('EXAMPLE\\');
    }
  });
});
