// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Per-workstation and per-user native client protocol overrides (#138):
 * PUT /workstations/{id} `nativeClientTransport` in workstation-manager, and
 * GET/PUT /users/{id}/native-client-transport in user-group-manager. Admins
 * only, and only the allowed values (or null to clear) are stored.
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
process.env.USER_TABLE_NAME = 'users';

// eslint-disable-next-line @typescript-eslint/no-var-requires
const workstationManager = require('../lambda/workstation-manager/index.js');
// eslint-disable-next-line @typescript-eslint/no-var-requires
const userGroupManager = require('../lambda/user-group-manager/index.js');

const INSTANCE = 'i-1234567890abcdef0';
const USER = 'IdentityCenter_artist@example.com';

function event(method: string, path: string, isAdmin: boolean, body?: unknown) {
  return {
    httpMethod: method,
    path,
    pathParameters: null,
    body: body === undefined ? null : JSON.stringify(body),
    requestContext: { authorizer: { isAdmin: String(isAdmin), username: 'caller@example.com', userId: 'caller@example.com' } },
  };
}

const writes = () => mockSend.mock.calls.map(([cmd]) => cmd).filter((cmd) => cmd.command === 'UpdateCommand');

let logs: jest.SpyInstance[];
beforeEach(() => {
  mockSend.mockReset();
  mockSend.mockResolvedValue({});
  logs = (['log', 'warn', 'error'] as const).map((m) => jest.spyOn(console, m).mockImplementation(() => {}));
});
afterEach(() => logs.forEach((l) => l.mockRestore()));

describe('PUT /workstations/{id} nativeClientTransport', () => {
  const put = (isAdmin: boolean, body: unknown) =>
    workstationManager.handler(event('PUT', `/workstations/${INSTANCE}`, isAdmin, body));

  it('refuses a non-admin and writes nothing', async () => {
    const res = await put(false, { nativeClientTransport: 'websocket' });
    expect(res.statusCode).toBe(403);
    expect(writes()).toHaveLength(0);
  });

  it.each(['websocket', 'quic'])('stores %s for an admin', async (value) => {
    const res = await put(true, { nativeClientTransport: value });
    expect(res.statusCode).toBe(200);
    expect(writes()).toHaveLength(1);
    expect(writes()[0].input).toMatchObject({
      TableName: 'workstations',
      Key: { instanceId: INSTANCE },
      UpdateExpression: 'SET nativeClientTransport = :nativeClientTransport',
      ExpressionAttributeValues: { ':nativeClientTransport': value },
    });
  });

  it.each([null, ''])('clears the override for %p', async (value) => {
    const res = await put(true, { nativeClientTransport: value });
    expect(res.statusCode).toBe(200);
    expect(writes()[0].input.UpdateExpression).toBe('REMOVE nativeClientTransport');
  });

  it.each(['tcp', 'udp', 'WEBSOCKET', 1, true, { S: 'websocket' }, ['websocket']])('rejects %p with 400 and writes nothing', async (value) => {
    const res = await put(true, { nativeClientTransport: value });
    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body).error).toMatch(/nativeClientTransport must be one of: quic, websocket/);
    expect(writes()).toHaveLength(0);
  });

  it('leaves other updates unchanged', async () => {
    const res = await put(true, { assignedUserId: USER });
    expect(res.statusCode).toBe(200);
    expect(writes()[0].input.UpdateExpression).toBe('SET assignedUserId = :assignedUserId');
  });
});

describe('/users/{id}/native-client-transport', () => {
  const path = `/users/${encodeURIComponent(USER)}/native-client-transport`;

  it.each(['GET', 'PUT'])('refuses a non-admin %s and reads or writes nothing', async (method) => {
    const res = await userGroupManager.handler(event(method, path, false, method === 'PUT' ? { nativeClientTransport: 'websocket' } : undefined));
    expect(res.statusCode).toBe(403);
    expect(mockSend).not.toHaveBeenCalled();
  });

  it('stores the override on the user record under the decoded user ID', async () => {
    const res = await userGroupManager.handler(event('PUT', path, true, { nativeClientTransport: 'websocket' }));
    expect(res.statusCode).toBe(200);
    expect(writes()).toHaveLength(1);
    expect(writes()[0].input).toEqual({
      TableName: 'users',
      Key: { userId: USER },
      UpdateExpression: 'SET nativeClientTransport = :t',
      ExpressionAttributeValues: { ':t': 'websocket' },
    });
  });

  it.each([null, ''])('clears with %p, without creating a record', async (value) => {
    const res = await userGroupManager.handler(event('PUT', path, true, { nativeClientTransport: value }));
    expect(res.statusCode).toBe(200);
    expect(writes()[0].input).toMatchObject({
      UpdateExpression: 'REMOVE nativeClientTransport',
      ConditionExpression: 'attribute_exists(userId)',
    });
  });

  it('treats clearing a user with no record as done', async () => {
    mockSend.mockRejectedValueOnce(Object.assign(new Error('The conditional request failed'), { name: 'ConditionalCheckFailedException' }));
    const res = await userGroupManager.handler(event('PUT', path, true, { nativeClientTransport: null }));
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toEqual({ nativeClientTransport: null });
  });

  it.each(['tcp', undefined, 'Quic', 0, { S: 'quic' }])('rejects %p with 400 and writes nothing', async (value) => {
    const res = await userGroupManager.handler(event('PUT', path, true, { nativeClientTransport: value }));
    expect(res.statusCode).toBe(400);
    expect(writes()).toHaveLength(0);
  });

  it('returns the stored value to an admin, and null for none or an unknown value', async () => {
    mockSend.mockResolvedValueOnce({ Item: { userId: USER, nativeClientTransport: 'websocket' } });
    let res = await userGroupManager.handler(event('GET', path, true));
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toEqual({ nativeClientTransport: 'websocket' });
    expect(mockSend.mock.calls[0][0].input).toEqual({ TableName: 'users', Key: { userId: USER } });

    mockSend.mockResolvedValueOnce({ Item: { userId: USER, nativeClientTransport: 'bogus' } });
    res = await userGroupManager.handler(event('GET', path, true));
    expect(JSON.parse(res.body)).toEqual({ nativeClientTransport: null });

    mockSend.mockResolvedValueOnce({});
    res = await userGroupManager.handler(event('GET', path, true));
    expect(JSON.parse(res.body)).toEqual({ nativeClientTransport: null });
  });
});
