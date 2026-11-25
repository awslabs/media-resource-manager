// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * delete-regional-hub refuses to delete a hub while workstations remain in
 * its Region (#145). The AWS SDK clients are mocked.
 */

export {};

type Call = { kind: string; input: any };
const mockCalls: Call[] = [];
const mockState: { hub: any; workstations: any[]; pageSize: number } = { hub: null, workstations: [], pageSize: 100 };

function mockCommand(kind: string) {
  return class {
    kind = kind;
    constructor(public input: any) {}
  };
}

jest.mock('@aws-sdk/client-dynamodb', () => ({ DynamoDBClient: class {} }), { virtual: true });
jest.mock('@aws-sdk/lib-dynamodb', () => ({
  GetCommand: mockCommand('Get'),
  UpdateCommand: mockCommand('Update'),
  ScanCommand: mockCommand('Scan'),
  DynamoDBDocumentClient: {
    from: () => ({
      send: async (cmd: Call) => {
        mockCalls.push(cmd);
        if (cmd.kind === 'Get') return { Item: mockState.hub };
        if (cmd.kind === 'Scan') {
          // Apply the region filter as DynamoDB would, one page at a time.
          const region = cmd.input.ExpressionAttributeValues[':region'];
          const matching = mockState.workstations.filter(w => w.region === region);
          const start = cmd.input.ExclusiveStartKey ? cmd.input.ExclusiveStartKey.offset : 0;
          const end = start + mockState.pageSize;
          return {
            Items: matching.slice(start, end),
            ...(end < matching.length ? { LastEvaluatedKey: { offset: end } } : {}),
          };
        }
        return {};
      },
    }),
  },
}), { virtual: true });
jest.mock('@aws-sdk/client-sfn', () => ({
  StartExecutionCommand: mockCommand('StartExecution'),
  SFNClient: class {
    async send(cmd: Call) {
      mockCalls.push(cmd);
      return { executionArn: 'arn:aws:states:us-east-1:123456789012:execution:hub-delete:1' };
    }
  },
}), { virtual: true });
jest.mock('@aws-sdk/client-ssm', () => ({
  GetParameterCommand: mockCommand('GetParameter'),
  SSMClient: class {
    async send(cmd: Call) {
      mockCalls.push(cmd);
      return { Parameter: { Value: 'arn:aws:states:us-east-1:123456789012:stateMachine:hub-delete' } };
    }
  },
}), { virtual: true });

process.env.REGIONAL_HUBS_TABLE_NAME = 'mrm-regional-hubs';
process.env.WORKSTATION_TABLE_NAME = 'mrm-workstations';
process.env.PASCAL_CASE_NAME = 'MediaResourceManager';

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { handler } = require('../lambda/delete-regional-hub/index.js');

const adminEvent = (region: string) => ({
  pathParameters: { region },
  requestContext: { authorizer: { isAdmin: 'true', username: 'admin' } },
});

const hub = (region: string, extra: object = {}) => ({ region, status: 'available', cloudFormationStackName: `MRM-Regional-Hub-${region}`, ...extra });
const ws = (n: number, region: string, extra: object = {}) => ({
  instanceId: `i-${String(n).padStart(17, '0')}`, hostname: `ws-${String(n).padStart(4, '0')}`, region, status: 'Running', instanceStatus: 'running', ...extra,
});

async function del(region: string) {
  const res = await handler(adminEvent(region));
  return { statusCode: res.statusCode, body: JSON.parse(res.body) };
}

const kinds = () => mockCalls.map(c => c.kind);

beforeEach(() => {
  mockCalls.length = 0;
  mockState.hub = hub('us-west-2');
  mockState.workstations = [];
  mockState.pageSize = 100;
});

describe('delete-regional-hub workstation check', () => {
  test('refuses with 409 and the count while running and stopped workstations remain', async () => {
    mockState.workstations = [ws(1, 'us-west-2'), ws(2, 'us-west-2', { status: 'Stopped', instanceStatus: 'stopped' })];
    const r = await del('us-west-2');
    expect(r.statusCode).toBe(409);
    expect(r.body.error).toBe('Terminate the 2 workstations in us-west-2 before deleting its regional hub.');
    expect(r.body.workstationCount).toBe(2);
    expect(kinds()).not.toContain('Update');
    expect(kinds()).not.toContain('StartExecution');
  });

  test('lists the workstations by hostname and instance ID, with the hint, and deletes nothing', async () => {
    mockState.workstations = [ws(2, 'us-west-2'), ws(1, 'us-west-2', { hostname: undefined, workstationName: 'edit-bay' })];
    const r = await del('us-west-2');
    expect(r.statusCode).toBe(409);
    expect(r.body.workstations).toEqual([
      { hostname: 'edit-bay', instanceId: ws(1, 'x').instanceId },
      { hostname: 'ws-0002', instanceId: ws(2, 'x').instanceId },
    ]);
    expect(r.body.moreCount).toBe(0);
    expect(r.body.hint).toBe('Snapshot or copy any data you need from these workstations, then terminate them before deleting the hub.');
    // Only reads: the hub record and the workstation scan
    expect(new Set(kinds())).toEqual(new Set(['Get', 'Scan']));
  });

  test('lists at most 20 workstations and counts the rest', async () => {
    mockState.workstations = Array.from({ length: 23 }, (_, i) => ws(i + 1, 'us-west-2'));
    const r = await del('us-west-2');
    expect(r.statusCode).toBe(409);
    expect(r.body.workstationCount).toBe(23);
    expect(r.body.workstations).toHaveLength(20);
    expect(r.body.workstations[0].hostname).toBe('ws-0001');
    expect(r.body.moreCount).toBe(3);
  });

  test('uses the singular for one workstation', async () => {
    mockState.workstations = [ws(1, 'us-west-2', { status: 'launching', instanceStatus: undefined })];
    const r = await del('us-west-2');
    expect(r.statusCode).toBe(409);
    expect(r.body.error).toBe('Terminate the 1 workstation in us-west-2 before deleting its regional hub.');
  });

  test('counts workstations on every page of the scan', async () => {
    mockState.pageSize = 1;
    mockState.workstations = [ws(1, 'us-west-2'), ws(2, 'us-west-2'), ws(3, 'us-west-2')];
    const r = await del('us-west-2');
    expect(r.statusCode).toBe(409);
    expect(r.body.workstationCount).toBe(3);
    expect(kinds().filter(k => k === 'Scan')).toHaveLength(3);
  });

  test('ignores terminated and failed records and workstations in other Regions', async () => {
    mockState.workstations = [
      ws(1, 'us-west-2', { status: 'Terminated', instanceStatus: 'terminated' }),
      ws(2, 'us-west-2', { status: 'failed', instanceStatus: undefined }),
      ws(3, 'us-west-2', { status: 'Running', instanceStatus: 'terminated' }),
      ws(4, 'eu-west-1'),
      ws(5, 'us-east-1'),
    ];
    const r = await del('us-west-2');
    expect(r.statusCode).toBe(202);
    expect(kinds()).toContain('Update');
    expect(kinds()).toContain('StartExecution');
  });

  test('starts the deletion when the Region has no workstations', async () => {
    const r = await del('us-west-2');
    expect(r.statusCode).toBe(202);
    expect(r.body.status).toBe('deleting');
    const scan = mockCalls.find(c => c.kind === 'Scan');
    expect(scan?.input.TableName).toBe('mrm-workstations');
    expect(scan?.input.ExpressionAttributeValues[':region']).toBe('us-west-2');
  });

  test('still refuses the primary Region, without scanning workstations', async () => {
    mockState.hub = hub('us-east-1', { isPrimary: true });
    const r = await del('us-east-1');
    expect(r.statusCode).toBe(400);
    expect(r.body.error).toBe('Cannot delete the primary region');
    expect(kinds()).not.toContain('Scan');
  });

  test('still refuses a hub that is not in a deletable state', async () => {
    mockState.hub = hub('us-west-2', { status: 'updating' });
    const r = await del('us-west-2');
    expect(r.statusCode).toBe(409);
    expect(r.body.error).toBe('Cannot delete regional hub in status: updating');
  });

  test('requires an administrator', async () => {
    const res = await handler({ pathParameters: { region: 'us-west-2' }, requestContext: { authorizer: { isAdmin: 'false' } } });
    expect(res.statusCode).toBe(403);
    expect(kinds()).toHaveLength(0);
  });
});
