// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * The JWT authorizer's AD token path: only the exact HS256 header ldap-auth
 * writes is accepted, so alg:none and HS/RS confusion tokens are refused even
 * when their HMAC matches, and the sign-in name is not logged (#85).
 */

import * as crypto from 'crypto';

const SIGNING_KEY = 'authorizer-test-signing-key'; // pragma: allowlist secret

jest.mock('@aws-sdk/client-secrets-manager', () => ({
  SecretsManagerClient: jest.fn().mockImplementation(() => ({
    send: jest.fn().mockResolvedValue({ SecretString: SIGNING_KEY }),
  })),
  GetSecretValueCommand: jest.fn(),
}), { virtual: true });
jest.mock('aws-jwt-verify', () => ({
  CognitoJwtVerifier: { create: () => ({ verify: async () => { throw new Error('not a Cognito token'); } }) },
}), { virtual: true });

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { handler } = require('../lambda/jwt-authorizer/index.js');

const b64 = (v: unknown) => Buffer.from(JSON.stringify(v)).toString('base64url');
const now = () => Math.floor(Date.now() / 1000);
function sign(header: Record<string, unknown>, claims: Record<string, unknown>) {
  const h = b64(header);
  const p = b64(claims);
  return `${h}.${p}.${crypto.createHmac('sha256', SIGNING_KEY).update(`${h}.${p}`).digest('base64url')}`;
}
const claims = { username: 'jdoe', email: 'jdoe@example.internal', isAdmin: false, iat: now(), exp: now() + 3600 };
const authorize = (token: string) => handler({ authorizationToken: `Bearer ${token}`, methodArn: 'arn:aws:execute-api:us-east-1:123456789012:api/prod/GET/workstations' });

let logged: string[];
beforeEach(() => {
  process.env.JWT_SECRET_ARN = 'arn:aws:secretsmanager:us-east-1:123456789012:secret:jwt'; // pragma: allowlist secret
  logged = [];
  for (const level of ['log', 'warn', 'error'] as const) {
    jest.spyOn(console, level).mockImplementation((...args: unknown[]) => {
      logged.push(args.map(a => (typeof a === 'string' ? a : JSON.stringify(a))).join(' '));
    });
  }
});
afterEach(() => jest.restoreAllMocks());

describe('jwt-authorizer AD tokens', () => {
  test('allows a valid HS256 token and does not log the sign-in name', async () => {
    const res = await authorize(sign({ alg: 'HS256', typ: 'JWT' }, claims));
    expect(res.policyDocument.Statement[0].Effect).toBe('Allow');
    expect(res.context.username).toBe('jdoe');
    for (const line of logged) expect(line).not.toContain('jdoe');
  });

  test.each<[string, Record<string, unknown>]>([
    ['alg:none', { alg: 'none', typ: 'JWT' }],
    ['RS256 signed with the shared key (HS/RS confusion)', { alg: 'RS256', typ: 'JWT' }],
    ['HS512', { alg: 'HS512', typ: 'JWT' }],
    ['a header with an extra kid', { alg: 'HS256', typ: 'JWT', kid: 'x' }],
    ['a header without typ', { alg: 'HS256' }],
  ])('refuses %s even when the HMAC matches', async (_name, header) => {
    await expect(authorize(sign(header, claims))).rejects.toThrow('Unauthorized');
  });

  test('refuses alg:none with an empty signature', async () => {
    await expect(authorize(`${b64({ alg: 'none', typ: 'JWT' })}.${b64(claims)}.`)).rejects.toThrow('Unauthorized');
  });
});
