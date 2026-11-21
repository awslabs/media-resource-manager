// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0
/**
 * The AdminSetup custom resource handler (lambda/create-admin-groups) must not
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

describe('create-admin-groups logging', () => {
  beforeEach(() => {
    mockCognitoSend.mockReset();
    // CloudFormation response: answer 200 without a network call.
    jest.spyOn(https, 'request').mockImplementation((...args: unknown[]) => {
      const callback = args[args.length - 1] as (res: { statusCode: number }) => void;
      return { on: jest.fn(), write: jest.fn(), end: () => callback({ statusCode: 200 }) };
    });
  });
  afterEach(() => jest.restoreAllMocks());

  it('logs neither the admin email addresses nor the ResponseURL', async () => {
    mockCognitoSend.mockImplementation(async (command: { name: string }) => {
      if (command.name === 'AdminGetUser') {
        throw Object.assign(new Error('not found'), { name: 'UserNotFoundException' });
      }
      return {};
    });
    const logs: unknown[] = [];
    for (const level of ['log', 'warn', 'error'] as const) {
      jest.spyOn(console, level).mockImplementation((...args) => { logs.push(args); });
    }

    await handler({
      RequestType: 'Create',
      ResponseURL: 'https://cloudformation-custom-resource-response.example.com/?X-Amz-Signature=abc',
      StackId: 'stack',
      RequestId: 'request-1',
      LogicalResourceId: 'AdminSetup',
      ResourceProperties: {
        UserPoolId: 'us-east-1_EXAMPLE',
        Groups: '["MRM-Admins"]',
        AdminEmails: '["first@example.com","second@example.com"]',
      },
    });

    const created = mockCognitoSend.mock.calls.filter(([c]) => c.name === 'AdminCreateUser');
    expect(created).toHaveLength(2);
    const logged = JSON.stringify(logs);
    expect(logged).not.toContain('@example.com');
    expect(logged).not.toContain('X-Amz-Signature');
    expect(logged).toContain('AdminEmails[1]');
  });
});
