// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * DELETE /storage/{storageId} tells the admin when a final backup will be kept
 * (FSx for Windows file systems and FSx for ONTAP volumes), with the file
 * system or volume ID, the Region and the commands to find and delete it.
 */

export {}; // module scope, so names here don't clash with other test files

let mockStorage: Record<string, unknown> | undefined;
let mockStackStatus: string | null;
const mockSent: string[] = [];

jest.mock('@aws-sdk/client-dynamodb', () => ({
  DynamoDBClient: jest.fn().mockImplementation(() => ({})),
}), { virtual: true });

jest.mock('@aws-sdk/lib-dynamodb', () => {
  const command = (name: string) => jest.fn().mockImplementation((input: unknown) => ({ name, input }));
  return {
    DynamoDBDocumentClient: {
      from: () => ({
        send: jest.fn().mockImplementation(async (cmd: { name: string }) => {
          mockSent.push(cmd.name);
          if (cmd.name === 'Get') return { Item: mockStorage };
          if (cmd.name === 'Query') return { Items: [] };
          return {};
        }),
      }),
    },
    GetCommand: command('Get'),
    DeleteCommand: command('Delete'),
    UpdateCommand: command('Update'),
    QueryCommand: command('Query'),
    BatchWriteCommand: command('BatchWrite'),
  };
}, { virtual: true });

jest.mock('@aws-sdk/client-sfn', () => ({
  SFNClient: jest.fn().mockImplementation(() => ({
    send: jest.fn().mockImplementation(async () => { mockSent.push('StartExecution'); return {}; }),
  })),
  StartExecutionCommand: jest.fn(),
}), { virtual: true });

jest.mock('@aws-sdk/client-cloudformation', () => ({
  CloudFormationClient: jest.fn().mockImplementation(() => ({
    send: jest.fn().mockImplementation(async (cmd: { name: string }) => {
      mockSent.push(cmd.name);
      if (cmd.name === 'DescribeStacks') {
        if (!mockStackStatus) throw new Error('Stack with id x does not exist');
        return { Stacks: [{ StackStatus: mockStackStatus }] };
      }
      return {};
    }),
  })),
  DescribeStacksCommand: jest.fn().mockImplementation(() => ({ name: 'DescribeStacks' })),
  DeleteStackCommand: jest.fn().mockImplementation(() => ({ name: 'DeleteStack' })),
}), { virtual: true });

jest.mock('@aws-sdk/client-ssm', () => ({
  SSMClient: jest.fn().mockImplementation(() => ({ send: jest.fn() })),
  GetParameterCommand: jest.fn(),
}), { virtual: true });

jest.mock('@aws-sdk/client-datasync', () => ({
  DataSyncClient: jest.fn().mockImplementation(() => ({ send: jest.fn() })),
  DeleteTaskCommand: jest.fn(),
  DeleteLocationCommand: jest.fn(),
}), { virtual: true });

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { handler } = require('../lambda/delete-storage/index.js');

const event = {
  httpMethod: 'DELETE',
  resource: '/storage/{storageId}',
  pathParameters: { storageId: 'st-1' },
  requestContext: { requestId: 'req-1', authorizer: { isAdmin: 'true', username: 'admin' } },
};

async function del() {
  const res = await handler(event);
  return { statusCode: res.statusCode, body: JSON.parse(res.body) };
}

beforeEach(() => {
  mockSent.length = 0;
  mockStackStatus = 'CREATE_COMPLETE';
  process.env.STORAGE_TABLE_NAME = 'mrm-storage';
  process.env.STORAGE_DELETION_STATE_MACHINE_ARN = 'arn:aws:states:us-east-1:123456789012:stateMachine:delete';
  delete process.env.DATASYNC_TABLE_SSM_PATH;
  jest.spyOn(console, 'log').mockImplementation(() => undefined);
  jest.spyOn(console, 'warn').mockImplementation(() => undefined);
  jest.spyOn(console, 'error').mockImplementation(() => undefined);
});

afterEach(() => {
  jest.restoreAllMocks();
});

describe('delete-storage final backup notice', () => {
  test('FSx for Windows: names the file system, the Region and the commands', async () => {
    mockStorage = { storageId: 'st-1', type: 'fsx-windows', status: 'available', cloudFormationStackName: 'MRM-Storage-st-1', region: 'us-west-2', fsxFileSystemId: 'fs-0123456789abcdef0' };
    const { statusCode, body } = await del();
    expect(statusCode).toBe(200);
    expect(body.message).toBe('Storage deletion started');
    expect(mockSent).toContain('StartExecution');
    expect(body.finalBackup).toEqual({
      resourceType: 'file system',
      resourceId: 'fs-0123456789abcdef0',
      region: 'us-west-2',
      message: expect.stringContaining('A final backup of file system fs-0123456789abcdef0 in us-west-2 will be kept'),
      findCommand: 'aws fsx describe-backups --region us-west-2 --filters Name=file-system-id,Values=fs-0123456789abcdef0',
      deleteCommand: 'aws fsx delete-backup --region us-west-2 --backup-id <backup-id>',
    });
  });

  test('FSx for ONTAP: names the volume', async () => {
    mockStorage = { storageId: 'st-1', type: 'fsx-ontap', status: 'available', cloudFormationStackName: 'MRM-Storage-st-1', region: 'eu-west-1', fsxFileSystemId: 'fs-0aaa', volumeId: 'fsvol-0bbb' };
    const { body } = await del();
    expect(body.finalBackup).toMatchObject({
      resourceType: 'volume',
      resourceId: 'fsvol-0bbb',
      region: 'eu-west-1',
      findCommand: 'aws fsx describe-backups --region eu-west-1 --filters Name=volume-id,Values=fsvol-0bbb',
    });
  });

  test('a record without a usable ID gets the notice without commands', async () => {
    mockStorage = { storageId: 'st-1', type: 'fsx-windows', status: 'available', cloudFormationStackName: 'MRM-Storage-st-1', region: 'us-east-1', fsxFileSystemId: 'fs-1; echo hi' };
    const { body } = await del();
    expect(body.finalBackup.message).toContain('A final backup of the deleted file system will be kept');
    expect(body.finalBackup.findCommand).toBeUndefined();
    expect(body.finalBackup.resourceId).toBeUndefined();
  });

  test('a DELETE_FAILED stack deleted directly gets the notice', async () => {
    mockStackStatus = 'DELETE_FAILED';
    mockStorage = { storageId: 'st-1', type: 'fsx-windows', status: 'failed', cloudFormationStackName: 'MRM-Storage-st-1', region: 'us-east-1', fsxFileSystemId: 'fs-0abc' };
    const { body } = await del();
    expect(body.message).toBe('Storage deleted successfully');
    expect(mockSent).toContain('DeleteStack');
    expect(body.finalBackup.resourceId).toBe('fs-0abc');
  });

  test.each<[string, Record<string, unknown>, string | null]>([
    ['Mountpoint for S3', { type: 'mountpoint-s3', status: 'available' }, 'CREATE_COMPLETE'],
    ['a rolled-back FSx create', { type: 'fsx-windows', status: 'failed', cloudFormationStackName: 'MRM-Storage-st-1', fsxFileSystemId: 'N/A' }, 'ROLLBACK_COMPLETE'],
    ['an FSx record whose stack is gone', { type: 'fsx-ontap', status: 'failed', cloudFormationStackName: 'MRM-Storage-st-1', volumeId: 'fsvol-0bbb' }, null],
  ])('%s gets no notice', async (_name, record, stackStatus) => {
    mockStackStatus = stackStatus;
    mockStorage = { storageId: 'st-1', region: 'us-east-1', ...record };
    const { statusCode, body } = await del();
    expect(statusCode).toBe(200);
    expect(body.finalBackup).toBeUndefined();
  });
});
