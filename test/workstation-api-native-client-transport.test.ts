// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * GET/POST /settings `nativeClientTransport` in lambda/workstation-api (#47).
 * The AWS SDK clients are replaced with in-memory fakes; SSM is a Map.
 */

const ssmStore = new Map<string, string>();

class ParameterNotFound extends Error {
  name = 'ParameterNotFound';
}

function fakeClient() {
  return class {
    send(command: { kind: string; input: any }) {
      if (command.kind === 'GetParameter') {
        if (!ssmStore.has(command.input.Name)) return Promise.reject(new ParameterNotFound());
        return Promise.resolve({ Parameter: { Value: ssmStore.get(command.input.Name) } });
      }
      if (command.kind === 'PutParameter') {
        ssmStore.set(command.input.Name, command.input.Value);
        return Promise.resolve({});
      }
      return Promise.resolve({});
    }
  };
}

function fakeCommand(kind: string) {
  return class {
    kind = kind;
    constructor(public input: any) {}
  };
}

function fakeModule(names: string[]) {
  const mod: Record<string, unknown> = {};
  for (const name of names) {
    if (name.endsWith('Client')) mod[name] = fakeClient();
    else mod[name] = fakeCommand(name.replace(/Command$/, ''));
  }
  return mod;
}

jest.mock('@aws-sdk/client-dynamodb', () => fakeModule(['DynamoDBClient']), { virtual: true });
jest.mock('@aws-sdk/lib-dynamodb', () => ({
  ...fakeModule(['ScanCommand', 'PutCommand', 'UpdateCommand', 'DeleteCommand', 'QueryCommand', 'GetCommand']),
  DynamoDBDocumentClient: { from: () => ({ send: () => Promise.resolve({}) }) },
}), { virtual: true });
jest.mock('@aws-sdk/client-ec2', () => fakeModule(['EC2Client', 'RunInstancesCommand', 'StartInstancesCommand', 'StopInstancesCommand', 'TerminateInstancesCommand', 'DescribeInstancesCommand', 'CreateTagsCommand']), { virtual: true });
jest.mock('@aws-sdk/client-ssm', () => fakeModule(['SSMClient', 'SendCommandCommand', 'GetCommandInvocationCommand', 'GetParameterCommand', 'PutParameterCommand']), { virtual: true });
jest.mock('@aws-sdk/client-sfn', () => fakeModule(['SFNClient', 'StartExecutionCommand']), { virtual: true });
jest.mock('@aws-sdk/client-directory-service', () => fakeModule(['DirectoryServiceClient', 'DescribeDirectoriesCommand', 'ResetUserPasswordCommand']), { virtual: true });
jest.mock('@aws-sdk/client-directory-service-data', () => fakeModule(['DirectoryServiceDataClient', 'ListGroupMembersCommand']), { virtual: true });
jest.mock('@aws-sdk/client-cognito-identity-provider', () => fakeModule(['CognitoIdentityProviderClient', 'ListUsersCommand']), { virtual: true });

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { handler: workstationApi } = require('../lambda/workstation-api/index.js');

const PARAM = '/MediaResourceManager/DCV/NativeClientTransport';

function event(method: string, isAdmin: boolean, body?: unknown) {
  return {
    httpMethod: method,
    path: '/settings',
    body: body === undefined ? null : JSON.stringify(body),
    requestContext: { authorizer: { isAdmin: String(isAdmin), userId: 'u' } },
  };
}

describe('workstation-api nativeClientTransport setting', () => {
  let log: jest.SpyInstance;
  beforeEach(() => {
    ssmStore.clear();
    delete process.env.PASCAL_CASE_NAME;
    log = jest.spyOn(console, 'log').mockImplementation(() => {});
  });
  afterEach(() => log.mockRestore());

  it('defaults to quic when the parameter does not exist, for every user', async () => {
    const res = await workstationApi(event('GET', false));
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body).nativeClientTransport).toBe('quic');
  });

  it('returns websocket to non-admins once an admin sets it', async () => {
    const save = await workstationApi(event('POST', true, { nativeClientTransport: 'websocket' }));
    expect(save.statusCode).toBe(200);
    expect(ssmStore.get(PARAM)).toBe('websocket');

    const res = await workstationApi(event('GET', false));
    expect(JSON.parse(res.body).nativeClientTransport).toBe('websocket');
  });

  it('maps an unexpected stored value to quic', async () => {
    ssmStore.set(PARAM, 'carrier-pigeon');
    const res = await workstationApi(event('GET', false));
    expect(JSON.parse(res.body).nativeClientTransport).toBe('quic');
  });

  it('rejects an unknown value with 400 and writes nothing', async () => {
    const res = await workstationApi(event('POST', true, { nativeClientTransport: 'tcp', browserSessionsEnabled: false }));
    expect(res.statusCode).toBe(400);
    expect(ssmStore.size).toBe(0);
  });

  it('rejects a non-admin save with 403', async () => {
    const res = await workstationApi(event('POST', false, { nativeClientTransport: 'websocket' }));
    expect(res.statusCode).toBe(403);
    expect(ssmStore.has(PARAM)).toBe(false);
  });

  it('leaves the setting alone when a save omits it', async () => {
    ssmStore.set(PARAM, 'websocket');
    const res = await workstationApi(event('POST', true, { browserSessionsEnabled: true }));
    expect(res.statusCode).toBe(200);
    expect(ssmStore.get(PARAM)).toBe('websocket');
  });
});
