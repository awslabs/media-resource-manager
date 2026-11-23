// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * workstation-manager serves the workstation routes. Listing workstations
 * logs a request summary, group membership checks and counts, and no
 * caller username, user ID variants, group member lists, headers, token or
 * authorizer context.
 */

export {}; // module scope, so names here don't clash with other test files

const mockSend = jest.fn();

// Any *Client is a client whose send() is mockSend; any *Command keeps its input and name.
function mockSdk(): any {
  return new Proxy({}, {
    get: (_t, name: string) => {
      if (name === '__esModule') return false;
      if (name === 'DynamoDBDocumentClient') return { from: () => ({ send: mockSend }) };
      if (name.endsWith('Client')) return jest.fn().mockImplementation(() => ({ send: mockSend }));
      return class { input: any; command = name; constructor(input: any) { this.input = input; } };
    },
  });
}

for (const m of ['@aws-sdk/client-dynamodb', '@aws-sdk/lib-dynamodb', '@aws-sdk/client-ec2', '@aws-sdk/client-sfn',
  '@aws-sdk/client-ssm', '@aws-sdk/client-directory-service', '@aws-sdk/client-directory-service-data',
  '@aws-sdk/client-lambda', '@aws-sdk/client-cognito-identity-provider']) {
  jest.doMock(m, () => mockSdk(), { virtual: true });
}

process.env.WORKSTATION_TABLE_NAME = 'workstations';
process.env.GROUPS_TABLE_NAME = 'groups';
process.env.USER_TABLE_NAME = 'users';

// eslint-disable-next-line @typescript-eslint/no-var-requires
const workstationManager = require('../lambda/workstation-manager/index.js');

const D = 'example.invalid';
const b64url = (s: string) => Buffer.from(s).toString('base64url');
const TOKEN = `${b64url('{"alg":"RS256"}')}.${b64url('{"sub":"test"}')}.${b64url('signature-test')}`;
const SENSITIVE = [D, 'wm.caller', 'wm.member2', TOKEN, '198.51.100.9', 'WmTestAgent'];

mockSend.mockImplementation(async (cmd: any) => {
  switch (cmd.command) {
    case 'ScanCommand':
      if (cmd.input.TableName === 'groups') {
        return { Items: [{ groupId: 'group-1', groupName: 'Editors', members: ['wm.caller', 'wm.member2'] }] };
      }
      return { Items: [] };
    case 'QueryCommand':
      return { Items: [] };
    case 'GetParameterCommand':
      return { Parameter: { Value: 'd-test' } };
    case 'ListGroupMembersCommand':
      return { Members: [{ SAMAccountName: 'wm.caller' }, { SAMAccountName: 'wm.member2' }] };
    default:
      return {};
  }
});

function listEvent(username: string, tokenType: string): any {
  return {
    resource: '/workstations', path: '/workstations', httpMethod: 'GET',
    headers: { Authorization: `Bearer ${TOKEN}`, 'User-Agent': 'WmTestAgent', 'X-Forwarded-For': '198.51.100.9' },
    multiValueHeaders: { Authorization: [`Bearer ${TOKEN}`] },
    requestContext: {
      requestId: 'req-wm-0001',
      authorizer: { username, email: `${username}@${D}`, isAdmin: 'false', tokenType },
      identity: { sourceIp: '198.51.100.9' },
    },
    body: null,
  };
}

async function logsFor(event: any): Promise<{ status: number; logged: string }> {
  let logged = '';
  const capture = (...args: unknown[]) => { logged += args.map(a => (typeof a === 'string' ? a : JSON.stringify(a))).join(' ') + '\n'; };
  const spies = (['log', 'info', 'warn', 'error', 'debug'] as const).map(l => jest.spyOn(console, l).mockImplementation(capture));
  try {
    const res = await workstationManager.handler(event);
    return { status: res.statusCode, logged };
  } finally {
    spies.forEach(s => s.mockRestore());
  }
}

function expectNoUserData(text: string) {
  for (const v of SENSITIVE) expect(text).not.toContain(v);
  expect(text).not.toMatch(/"headers"|"multiValueHeaders"|authorization|"authorizer"|"identity"/i);
}

describe('workstation-manager list logging', () => {
  it('Cognito user: logs the request summary and group match, not the user', async () => {
    const { status, logged } = await logsFor(listEvent('IdentityCenter_wm.caller', 'cognito'));
    expect(status).toBe(200);
    expect(logged).toContain('"requestId":"req-wm-0001"');
    expect(logged).toContain('User is a member of group Editors');
    expect(logged).toContain('user ID variants');
    expectNoUserData(logged);
  });

  it('LDAP user: logs group member counts, not the member list', async () => {
    const { status, logged } = await logsFor(listEvent('wm.caller', 'ldap'));
    expect(status).toBe(200);
    expect(logged).toContain('Group Editors has 2 members');
    expectNoUserData(logged);
  });
});
