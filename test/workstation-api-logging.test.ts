// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * The workstation list in workstation-api resolves each assigned user to a
 * display name and checks group membership. Its logs record how a user was
 * resolved and how many members a group has, and no user ID, email address,
 * name or member list.
 */

export {}; // module scope, so names here don't clash with other test files

const mockSend = jest.fn();

// Each SDK command is a class that keeps its input and its own name.
function mockCommand(name: string) {
  return class {
    input: any;
    command = name;
    constructor(input: any) { this.input = input; }
  };
}
function mockClient() {
  return jest.fn().mockImplementation(() => ({ send: mockSend }));
}

jest.mock('@aws-sdk/client-dynamodb', () => ({ DynamoDBClient: mockClient() }), { virtual: true });
jest.mock('@aws-sdk/lib-dynamodb', () => ({
  DynamoDBDocumentClient: { from: () => ({ send: mockSend }) },
  ScanCommand: mockCommand('Scan'), PutCommand: mockCommand('Put'), UpdateCommand: mockCommand('Update'),
  DeleteCommand: mockCommand('Delete'), QueryCommand: mockCommand('Query'), GetCommand: mockCommand('Get'),
}), { virtual: true });
jest.mock('@aws-sdk/client-ec2', () => ({
  EC2Client: mockClient(), RunInstancesCommand: mockCommand('RunInstances'), StartInstancesCommand: mockCommand('StartInstances'),
  StopInstancesCommand: mockCommand('StopInstances'), TerminateInstancesCommand: mockCommand('TerminateInstances'),
  DescribeInstancesCommand: mockCommand('DescribeInstances'), CreateTagsCommand: mockCommand('CreateTags'),
}), { virtual: true });
jest.mock('@aws-sdk/client-ssm', () => ({
  SSMClient: mockClient(), SendCommandCommand: mockCommand('SendCommand'), GetCommandInvocationCommand: mockCommand('GetCommandInvocation'),
  GetParameterCommand: mockCommand('GetParameter'), PutParameterCommand: mockCommand('PutParameter'),
}), { virtual: true });
jest.mock('@aws-sdk/client-sfn', () => ({ SFNClient: mockClient(), StartExecutionCommand: mockCommand('StartExecution') }), { virtual: true });
jest.mock('@aws-sdk/client-directory-service', () => ({
  DirectoryServiceClient: mockClient(), DescribeDirectoriesCommand: mockCommand('DescribeDirectories'),
  ResetUserPasswordCommand: mockCommand('ResetUserPassword'),
}), { virtual: true });
jest.mock('@aws-sdk/client-directory-service-data', () => ({
  DirectoryServiceDataClient: mockClient(), ListGroupMembersCommand: mockCommand('ListGroupMembers'),
}), { virtual: true });
jest.mock('@aws-sdk/client-cognito-identity-provider', () => ({
  CognitoIdentityProviderClient: mockClient(), ListUsersCommand: mockCommand('ListUsers'),
}), { virtual: true });

process.env.WORKSTATION_TABLE_NAME = 'workstations';
process.env.GROUPS_TABLE_NAME = 'groups';
process.env.USER_TABLE_NAME = 'users';

// eslint-disable-next-line @typescript-eslint/no-var-requires
const workstationApi = require('../lambda/workstation-api/index.js');

const D = 'example.invalid';
// One workstation per lookup route in findUserByAssignedId.
const WORKSTATIONS = [
  { instanceId: 'i-test-ws1', assignedUserId: `alice.one@${D}` },       // DynamoDB exact
  { instanceId: 'i-test-ws2', assignedUserId: `Okta_bob.two@${D}` },    // DynamoDB formatted
  { instanceId: 'i-test-ws3', assignedUserId: 'carol.three' },          // DynamoDB email prefix
  { instanceId: 'i-test-ws4', assignedUserId: `dave.four@${D}` },       // Cognito formatted
  { instanceId: 'i-test-ws5', assignedUserId: `erin.five@${D}` },       // not found
  { instanceId: 'i-test-ws6', assignedUserId: 'group-1' },              // group
];
const DB_USERS = [
  { userId: `alice.one@${D}`, email: `alice.one@${D}`, firstName: 'Alicefirst', lastName: 'Onelast' },
  { userId: 'bob.two', email: `bob.two@${D}`, firstName: 'Bobfirst', lastName: 'Twolast' },
  { userId: 'u-carol', email: `carol.three@${D}`, firstName: 'Carolfirst', lastName: 'Threelast' },
];
const COGNITO_USERS = [{
  Username: `IdentityCenter_dave.four@${D}`,
  Attributes: [{ Name: 'email', Value: `dave.four@${D}` }, { Name: 'given_name', Value: 'Davefirst' }, { Name: 'family_name', Value: 'Fourlast' }],
}];
const GROUPS = [{ groupId: 'group-1', groupName: 'Editors' }];
const SENSITIVE = [D, 'alice.one', 'bob.two', 'carol.three', 'dave.four', 'erin.five', 'frank.six', 'gina.seven', 'u-carol',
  'Alicefirst', 'Onelast', 'Bobfirst', 'Twolast', 'Carolfirst', 'Threelast', 'Davefirst', 'Fourlast'];

mockSend.mockImplementation(async (cmd: any) => {
  switch (cmd.command) {
    case 'Scan':
      if (cmd.input.TableName === 'workstations') return { Items: WORKSTATIONS.map(w => ({ ...w })) };
      if (cmd.input.TableName === 'groups') return { Items: GROUPS };
      if (cmd.input.TableName === 'users') return { Items: DB_USERS };
      return { Items: [] };
    case 'Query':
      return { Items: cmd.input.ExpressionAttributeValues[':userId'] === 'frank.six' ? [{ ...WORKSTATIONS[0] }] : [{ ...WORKSTATIONS[5] }] };
    case 'GetParameter':
      return { Parameter: { Value: cmd.input.Name.endsWith('UserPoolId') ? 'us-east-1_EXAMPLE' : 'd-0000000000' } };
    case 'ListGroupMembers':
      return { Members: [{ SAMAccountName: 'frank.six' }, { SAMAccountName: 'gina.seven' }] };
    case 'ListUsers':
      return { Users: COGNITO_USERS };
    case 'DescribeInstances':
      return { Reservations: [] };
    default:
      return {};
  }
});

let logged: string;
let spies: jest.SpyInstance[];

beforeEach(() => {
  logged = '';
  const capture = (...args: unknown[]) => {
    logged += args.map(a => (typeof a === 'string' ? a : JSON.stringify(a))).join(' ') + '\n';
  };
  spies = (['log', 'info', 'warn', 'error', 'debug'] as const)
    .map(level => jest.spyOn(console, level).mockImplementation(capture));
});

afterEach(() => {
  spies.forEach(s => s.mockRestore());
});

function listEvent(username: string, isAdmin: boolean): any {
  return { httpMethod: 'GET', path: '/workstations', body: null, requestContext: { authorizer: { username, isAdmin: String(isAdmin) } } };
}

function expectNoUserData(text: string) {
  for (const value of SENSITIVE) expect(text).not.toContain(value);
}

describe('workstation-api list logging', () => {
  it('admin list: resolves every assigned user and logs only how each was resolved', async () => {
    const res = await workstationApi.handler(listEvent(`admin.user@${D}`, true));
    expect(res.statusCode).toBe(200);
    const items = JSON.parse(res.body).workstations ?? JSON.parse(res.body);
    const display = Object.fromEntries((Array.isArray(items) ? items : []).map((w: any) => [w.instanceId, w.assignedUserDisplay]));
    // Display names are still resolved for the UI.
    expect(display['i-test-ws1']).toBe('Alicefirst Onelast');
    expect(display['i-test-ws4']).toBe('Davefirst Fourlast');
    expect(display['i-test-ws6']).toBe('Editors (Group)');

    expect(logged).toContain('Resolved assigned user: DynamoDB, exact match');
    expect(logged).toContain('Resolved assigned user: DynamoDB, formatted match');
    expect(logged).toContain('Resolved assigned user: DynamoDB, email prefix');
    expect(logged).toContain('Resolved assigned user: Cognito, formatted username');
    expect(logged).toContain('Assigned user not found in DynamoDB or Cognito');
    expectNoUserData(logged);
    expect(logged).not.toContain('admin.user');
  });

  it('user list: logs group member counts, not the caller or the members', async () => {
    const res = await workstationApi.handler(listEvent(`frank.six@${D}`, false));
    expect(res.statusCode).toBe(200);
    expect(logged).toContain('Group Editors has 2 members');
    expect(logged).toContain('User is a member of group Editors');
    expectNoUserData(logged);
  });
});
