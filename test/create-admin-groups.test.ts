// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0
/**
 * The AdminSetup custom resource handler (lambda/create-admin-groups).
 *
 * After an upgrade the Frontend stack CREATES AdminSetup even though the
 * AdminEmails users already exist, so existing users must be skipped: no
 * failed deploy, no new invite, no password reset. The handler must also not
 * log AdminEmails addresses or the pre-signed ResponseURL.
 */
const mockCognitoSend = jest.fn();
jest.mock('@aws-sdk/client-cognito-identity-provider', () => {
  const command = (name: string) => jest.fn((input) => ({ name, input }));
  return {
    CognitoIdentityProviderClient: jest.fn(() => ({ send: mockCognitoSend })),
    CreateGroupCommand: command('CreateGroup'),
    AdminCreateUserCommand: command('AdminCreateUser'),
    AdminAddUserToGroupCommand: command('AdminAddUserToGroup'),
    AdminGetUserCommand: command('AdminGetUser'),
  };
}, { virtual: true });

// eslint-disable-next-line @typescript-eslint/no-var-requires
const https = require('https');
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { handler } = require('../lambda/create-admin-groups/index.js');

export {};

type Command = { name: string; input: Record<string, unknown> };

const awsError = (name: string) => Object.assign(new Error(name), { name });

function createEvent(emails: string[]) {
  return {
    RequestType: 'Create',
    ResponseURL: 'https://cloudformation-custom-resource-response.example.com/?X-Amz-Signature=abc',
    StackId: 'stack',
    RequestId: 'request-1',
    LogicalResourceId: 'AdminSetup',
    ResourceProperties: {
      UserPoolId: 'us-east-1_EXAMPLE',
      Groups: '["MRM-Admins"]',
      AdminEmails: JSON.stringify(emails),
    },
  };
}

const sent = (name: string) => mockCognitoSend.mock.calls.map(([c]) => c as Command).filter(c => c.name === name);

describe('create-admin-groups', () => {
  let responses: { Status: string; Reason?: string }[];
  let logs: unknown[];

  beforeEach(() => {
    mockCognitoSend.mockReset();
    responses = [];
    logs = [];
    // CloudFormation response: record it and answer 200 without a network call.
    jest.spyOn(https, 'request').mockImplementation((...args: unknown[]) => {
      const callback = args[args.length - 1] as (res: { statusCode: number }) => void;
      return {
        on: jest.fn(),
        write: (body: string) => responses.push(JSON.parse(body)),
        end: () => callback({ statusCode: 200 }),
      };
    });
    for (const level of ['log', 'warn', 'error'] as const) {
      jest.spyOn(console, level).mockImplementation((...args) => { logs.push(args); });
    }
  });
  afterEach(() => jest.restoreAllMocks());

  it('creates missing users and logs neither their addresses nor the ResponseURL', async () => {
    mockCognitoSend.mockImplementation(async (command: Command) => {
      if (command.name === 'AdminGetUser') throw awsError('UserNotFoundException');
      return {};
    });

    await handler(createEvent(['first@example.com', 'second@example.com']));

    expect(sent('AdminCreateUser')).toHaveLength(2);
    expect(responses).toEqual([expect.objectContaining({ Status: 'SUCCESS' })]);
    const logged = JSON.stringify(logs);
    expect(logged).not.toContain('@example.com');
    expect(logged).not.toContain('X-Amz-Signature');
    expect(logged).toContain('AdminEmails[1]');
    expect(logged).toContain('2 created, 0 already existed');
  });

  it('on upgrade, skips users that already exist: no invite, no reset, deploy succeeds', async () => {
    mockCognitoSend.mockImplementation(async (command: Command) => {
      if (command.name === 'CreateGroup') throw awsError('GroupExistsException');
      return {}; // AdminGetUser finds every user
    });

    await handler(createEvent(['first@example.com', 'second@example.com']));

    expect(sent('AdminCreateUser')).toHaveLength(0);
    expect(responses).toEqual([expect.objectContaining({ Status: 'SUCCESS' })]);
    expect(JSON.stringify(logs)).toContain('0 created, 2 already existed');
    // Re-adding a member to its group is a no-op in Cognito.
    expect(sent('AdminAddUserToGroup')).toHaveLength(2);
  });

  it.each(['UsernameExistsException', 'AliasExistsException'])(
    'treats %s from AdminCreateUser as an existing user, not a failed deploy', async (errorName) => {
      mockCognitoSend.mockImplementation(async (command: Command) => {
        if (command.name === 'AdminGetUser') throw awsError('UserNotFoundException');
        if (command.name === 'AdminCreateUser') throw awsError(errorName);
        return {};
      });

      await handler(createEvent(['first@example.com']));

      expect(responses).toEqual([expect.objectContaining({ Status: 'SUCCESS' })]);
      expect(JSON.stringify(logs)).toContain('0 created, 1 already existed');
    });

  it('still fails the deploy on other errors', async () => {
    mockCognitoSend.mockImplementation(async (command: Command) => {
      if (command.name === 'AdminGetUser') throw awsError('UserNotFoundException');
      if (command.name === 'AdminCreateUser') throw awsError('InvalidParameterException');
      return {};
    });

    await handler(createEvent(['first@example.com']));

    expect(responses).toEqual([expect.objectContaining({ Status: 'FAILED' })]);
  });
});
