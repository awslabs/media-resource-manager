// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * delete-storage with a record whose cloudFormationStackName isn't an MRM
 * storage stack (#143), and the order of the DataSync cleanup. The AWS SDK
 * clients are mocked.
 */

export {};

type Call = { kind: string; input: any };
const mockCalls: Call[] = [];
const mockState: {
  storage: any;
  stack: { status?: string; error?: string } | null;
  locations: any[];
  tasks: any[];
} = { storage: null, stack: null, locations: [], tasks: [] };

function mockCommand(kind: string) {
  return class {
    kind = kind;
    constructor(public input: any) {}
  };
}

jest.mock('@aws-sdk/client-dynamodb', () => ({ DynamoDBClient: class {} }), { virtual: true });
jest.mock('@aws-sdk/lib-dynamodb', () => ({
  GetCommand: mockCommand('Get'),
  DeleteCommand: mockCommand('Delete'),
  UpdateCommand: mockCommand('Update'),
  QueryCommand: mockCommand('Query'),
  BatchWriteCommand: mockCommand('BatchWrite'),
  DynamoDBDocumentClient: {
    from: () => ({
      send: async (cmd: Call) => {
        mockCalls.push(cmd);
        if (cmd.kind === 'Get') return { Item: mockState.storage };
        if (cmd.kind === 'Query') {
          const type = cmd.input.ExpressionAttributeValues?.[':type'];
          if (type === 'LOCATION') return { Items: mockState.locations };
          if (type === 'TASK') return { Items: mockState.tasks };
          return { Items: [] };
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
      return {};
    }
  },
}), { virtual: true });
jest.mock('@aws-sdk/client-cloudformation', () => ({
  DescribeStacksCommand: mockCommand('DescribeStacks'),
  DeleteStackCommand: mockCommand('DeleteStack'),
  CloudFormationClient: class {
    async send(cmd: Call) {
      mockCalls.push(cmd);
      if (cmd.kind === 'DescribeStacks') {
        // The delete Lambda's role may describe only <Acronym>-Storage-* stacks.
        if (!String(cmd.input.StackName).startsWith('MRM-Storage-')) {
          throw Object.assign(new Error('User is not authorized to perform: cloudformation:DescribeStacks'), { name: 'AccessDenied' });
        }
        if (mockState.stack?.error) throw new Error(mockState.stack.error);
        if (!mockState.stack) throw new Error(`Stack with id ${cmd.input.StackName} does not exist`);
        return { Stacks: [{ StackName: cmd.input.StackName, StackStatus: mockState.stack.status }] };
      }
      return {};
    }
  },
}), { virtual: true });
jest.mock('@aws-sdk/client-ssm', () => ({
  GetParameterCommand: mockCommand('GetParameter'),
  SSMClient: class {
    async send(cmd: Call) {
      mockCalls.push(cmd);
      return { Parameter: { Value: 'mrm-datasync' } };
    }
  },
}), { virtual: true });
jest.mock('@aws-sdk/client-datasync', () => ({
  DeleteTaskCommand: mockCommand('DeleteTask'),
  DeleteLocationCommand: mockCommand('DeleteLocation'),
  DataSyncClient: class {
    async send(cmd: Call) {
      mockCalls.push(cmd);
      return {};
    }
  },
}), { virtual: true });

process.env.AWS_REGION = 'us-east-1';
process.env.STORAGE_TABLE_NAME = 'mrm-storage';
process.env.DATASYNC_TABLE_SSM_PATH = '/MediaResourceManager/DataSync/TableName';
process.env.STORAGE_DELETION_STATE_MACHINE_ARN = 'arn:aws:states:us-east-1:123456789012:stateMachine:mrm-storage-deletion';
process.env.ACRONYM = 'MRM';

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { handler } = require('../lambda/delete-storage/index.js');

const STORAGE_ID = 'st-1234';
const record = (extra: object = {}) => ({ storageId: STORAGE_ID, name: 'media', type: 'fsx-windows', status: 'available', ...extra });
const location = { pk: 'LOCATION#loc-1', sk: 'METADATA', type: 'LOCATION', locationId: 'loc-1', storageId: STORAGE_ID, locationArn: 'arn:aws:datasync:us-east-1:123456789012:location/loc-1' };
const task = { pk: 'TASK#task-1', sk: 'METADATA', type: 'TASK', taskId: 'task-1', sourceLocationId: 'loc-1', destinationLocationId: 'loc-2', taskArn: 'arn:aws:datasync:us-east-1:123456789012:task/task-1' };

async function del() {
  const res = await handler({ pathParameters: { storageId: STORAGE_ID }, requestContext: { authorizer: { isAdmin: 'true', username: 'admin' } } });
  return { statusCode: res.statusCode, body: JSON.parse(res.body) };
}

const kinds = () => mockCalls.map(c => c.kind);
const deletedStorageRecord = () => mockCalls.some(c => c.kind === 'Delete' && c.input.TableName === 'mrm-storage');

beforeEach(() => {
  mockCalls.length = 0;
  mockState.storage = record();
  mockState.stack = null;
  mockState.locations = [];
  mockState.tasks = [];
});

describe('delete-storage with a stack name that is not an MRM storage stack', () => {
  test.each(['N/A', 'customer-fsx-stack', 'Other-Storage-st-1234'])('removes the record for %j without DescribeStacks or DeleteStack', async stackName => {
    mockState.storage = record({ cloudFormationStackName: stackName });
    const r = await del();
    expect(r.statusCode).toBe(200);
    expect(r.body.success).toBe(true);
    expect(r.body.message).toBe('Storage record removed. MRM did not create this file system, so the file system itself was not changed.');
    expect(deletedStorageRecord()).toBe(true);
    expect(kinds()).not.toContain('DescribeStacks');
    expect(kinds()).not.toContain('DeleteStack');
    expect(kinds()).not.toContain('StartExecution');
  });

  test('also removes the DataSync tasks and locations MRM created for it', async () => {
    mockState.storage = record({ cloudFormationStackName: 'N/A' });
    mockState.locations = [location];
    mockState.tasks = [task];
    const r = await del();
    expect(r.statusCode).toBe(200);
    expect(kinds()).toContain('DeleteTask');
    expect(kinds()).toContain('DeleteLocation');
    expect(deletedStorageRecord()).toBe(true);
  });

  test('removes a record with an empty stack name without DescribeStacks', async () => {
    mockState.storage = record({ cloudFormationStackName: '' });
    const r = await del();
    expect(r.statusCode).toBe(200);
    expect(deletedStorageRecord()).toBe(true);
    expect(kinds()).not.toContain('DescribeStacks');
  });
});

describe('delete-storage with an MRM storage stack', () => {
  test('describes the stack and starts the deletion workflow for an active stack', async () => {
    mockState.storage = record({ cloudFormationStackName: 'MRM-Storage-st-1234' });
    mockState.stack = { status: 'CREATE_COMPLETE' };
    const r = await del();
    expect(r.statusCode).toBe(200);
    expect(r.body.status).toBe('deleting');
    expect(kinds()).toContain('DescribeStacks');
    expect(kinds()).toContain('StartExecution');
    expect(deletedStorageRecord()).toBe(false);
  });

  test('removes the DataSync resources before it starts the deletion workflow', async () => {
    mockState.storage = record({ cloudFormationStackName: 'MRM-Storage-st-1234' });
    mockState.stack = { status: 'CREATE_COMPLETE' };
    mockState.locations = [location];
    mockState.tasks = [task];
    await del();
    const k = kinds();
    expect(k.indexOf('DescribeStacks')).toBeLessThan(k.indexOf('DeleteLocation'));
    expect(k.indexOf('DeleteLocation')).toBeLessThan(k.indexOf('StartExecution'));
  });

  test('removes the record when the stack is already gone', async () => {
    mockState.storage = record({ cloudFormationStackName: 'MRM-Storage-st-1234' });
    const r = await del();
    expect(r.statusCode).toBe(200);
    expect(r.body.message).toBe('Storage deleted successfully');
    expect(deletedStorageRecord()).toBe(true);
  });

  test('keeps the DataSync resources when the stack check fails', async () => {
    mockState.storage = record({ cloudFormationStackName: 'MRM-Storage-st-1234' });
    mockState.stack = { error: 'Rate exceeded' };
    mockState.locations = [location];
    mockState.tasks = [task];
    const r = await del();
    expect(r.statusCode).toBe(500);
    expect(kinds()).not.toContain('DeleteTask');
    expect(kinds()).not.toContain('DeleteLocation');
    expect(deletedStorageRecord()).toBe(false);
  });

  test('keeps the DataSync resources while the storage is still being created', async () => {
    mockState.storage = record({ cloudFormationStackName: 'MRM-Storage-st-1234', status: 'creating' });
    mockState.stack = { status: 'CREATE_IN_PROGRESS' };
    mockState.locations = [location];
    const r = await del();
    expect(r.statusCode).toBe(409);
    expect(kinds()).not.toContain('DeleteLocation');
  });

  test('keeps the DataSync resources when the storage is already being deleted', async () => {
    mockState.storage = record({ cloudFormationStackName: 'MRM-Storage-st-1234', status: 'deleting' });
    mockState.locations = [location];
    const r = await del();
    expect(r.statusCode).toBe(409);
    expect(kinds()).not.toContain('DeleteLocation');
  });
});
