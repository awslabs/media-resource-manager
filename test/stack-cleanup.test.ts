// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0
/**
 * The StackCleanup custom resource handler (lambda/stack-cleanup).
 *
 * On stack delete it terminates every workstation in the workstation table.
 * A record can outlive its instance, so instances that no longer exist, or are
 * already shutting down or terminated, count as cleaned up and must not fail
 * the stack delete. Real EC2 errors such as AccessDenied still fail it.
 */
const mockEc2Send = jest.fn();
const mockDynamoSend = jest.fn();
const mockSsmSend = jest.fn();
const command = (name: string) => jest.fn((input) => ({ name, input }));

jest.mock('@aws-sdk/client-ec2', () => ({
  EC2Client: jest.fn(() => ({ send: mockEc2Send })),
  DescribeInstancesCommand: command('DescribeInstances'),
  TerminateInstancesCommand: command('TerminateInstances'),
  DescribeNetworkInterfacesCommand: command('DescribeNetworkInterfaces'),
  DeleteNetworkInterfaceCommand: command('DeleteNetworkInterface'),
}), { virtual: true });
jest.mock('@aws-sdk/client-dynamodb', () => ({ DynamoDBClient: jest.fn() }), { virtual: true });
jest.mock('@aws-sdk/lib-dynamodb', () => ({
  DynamoDBDocumentClient: { from: jest.fn(() => ({ send: mockDynamoSend })) },
  ScanCommand: command('Scan'),
}), { virtual: true });
jest.mock('@aws-sdk/client-ssm', () => ({
  SSMClient: jest.fn(() => ({ send: mockSsmSend })),
  GetParametersByPathCommand: command('GetParametersByPath'),
  DeleteParametersCommand: command('DeleteParameters'),
}), { virtual: true });

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { handler } = require('../lambda/stack-cleanup/index.js');

export {};

type Command = { name: string; input: Record<string, any> };
type Eni = { NetworkInterfaceId: string; Status: string; Description: string };

const awsError = (name: string) => Object.assign(new Error(name), { name });

const deleteEvent = {
  RequestType: 'Delete',
  ResourceProperties: {
    SecurityGroupId: 'sg-example',
    WorkstationTableName: 'workstations',
    SsmParameterPrefix: '/Example/DCV',
  },
};

/**
 * A small EC2 model. Like EC2, DescribeInstances and TerminateInstances with
 * InstanceIds fail the whole call with InvalidInstanceID.NotFound when any ID
 * doesn't exist, and an instance-id filter returns only the ones that do.
 */
let instances: Map<string, string>;
let enis: Eni[];
let terminateOverride: ((ids: string[]) => void) | undefined;

const sent = (name: string) => mockEc2Send.mock.calls.map(([c]) => c as Command).filter(c => c.name === name);
const terminated = () => sent('TerminateInstances').flatMap(c => c.input.InstanceIds as string[]);

function ec2(cmd: Command) {
  const listed = (ids: string[]) => ids.filter(id => instances.has(id))
    .map(id => ({ InstanceId: id, State: { Name: instances.get(id) } }));
  const requireAll = (ids: string[]) => {
    if (ids.some(id => !instances.has(id))) throw awsError('InvalidInstanceID.NotFound');
  };
  switch (cmd.name) {
    case 'DescribeInstances': {
      const ids = cmd.input.InstanceIds ?? cmd.input.Filters.find((f: any) => f.Name === 'instance-id').Values;
      if (cmd.input.InstanceIds) requireAll(ids);
      const found = listed(ids);
      return { Reservations: found.length ? [{ Instances: found }] : [] };
    }
    case 'TerminateInstances': {
      const ids = cmd.input.InstanceIds as string[];
      terminateOverride?.(ids);
      requireAll(ids);
      ids.forEach(id => instances.set(id, 'terminated'));
      return {};
    }
    case 'DescribeNetworkInterfaces':
      return { NetworkInterfaces: enis };
    case 'DeleteNetworkInterface': {
      const id = cmd.input.NetworkInterfaceId;
      const before = enis.length;
      enis = enis.filter(e => e.NetworkInterfaceId !== id);
      if (enis.length === before) throw awsError('InvalidNetworkInterfaceID.NotFound');
      return {};
    }
  }
  throw new Error(`unexpected command ${cmd.name}`);
}

function workstations(...instanceIds: (string | undefined)[]) {
  mockDynamoSend.mockResolvedValue({
    Items: instanceIds.map((instanceId, n) => ({ workstationId: `ws-${n}`, status: 'running', instanceId })),
  });
}

describe('stack-cleanup on Delete', () => {
  beforeEach(() => {
    mockEc2Send.mockReset().mockImplementation(async (cmd: Command) => ec2(cmd));
    mockDynamoSend.mockReset();
    mockSsmSend.mockReset().mockResolvedValue({ Parameters: [] });
    instances = new Map();
    enis = [];
    terminateOverride = undefined;
    jest.spyOn(console, 'log').mockImplementation(() => undefined);
    jest.spyOn(console, 'error').mockImplementation(() => undefined);
    // Run waits at once.
    jest.spyOn(global, 'setTimeout').mockImplementation(((fn: () => void) => { fn(); return 0; }) as any);
  });

  afterEach(() => jest.restoreAllMocks());

  test('succeeds when every workstation instance no longer exists', async () => {
    workstations('i-gone1', 'i-gone2');

    await expect(handler(deleteEvent)).resolves.toEqual(expect.objectContaining({ PhysicalResourceId: 'cleanup-resource' }));
    expect(terminated()).toEqual([]);
  });

  test('terminates only instances that exist and are not already ending', async () => {
    instances.set('i-running', 'running');
    instances.set('i-stopped', 'stopped');
    instances.set('i-ending', 'shutting-down');
    instances.set('i-done', 'terminated');
    workstations('i-running', 'i-stopped', 'i-ending', 'i-done', 'i-gone', undefined, 'i-running');

    await expect(handler(deleteEvent)).resolves.toBeDefined();
    expect(terminated().sort()).toEqual(['i-running', 'i-stopped']);
  });

  test('retries when an instance disappears between describe and terminate', async () => {
    instances.set('i-running', 'running');
    instances.set('i-vanishing', 'running');
    workstations('i-running', 'i-vanishing');
    terminateOverride = () => {
      if (instances.get('i-vanishing') === 'running') instances.delete('i-vanishing');
      terminateOverride = undefined;
    };

    await expect(handler(deleteEvent)).resolves.toBeDefined();
    expect(sent('TerminateInstances').map(c => c.input.InstanceIds)).toEqual([['i-running', 'i-vanishing'], ['i-running']]);
    expect(instances.get('i-running')).toBe('terminated');
  });

  test('fails the cleanup on a real EC2 error', async () => {
    instances.set('i-running', 'running');
    workstations('i-running');
    terminateOverride = () => { throw awsError('UnauthorizedOperation'); };

    await expect(handler(deleteEvent)).rejects.toThrow('UnauthorizedOperation');
  });

  test('fails the cleanup when describing instances is denied', async () => {
    workstations('i-running');
    mockEc2Send.mockImplementation(async (cmd: Command) => {
      if (cmd.name === 'DescribeInstances') throw awsError('AccessDenied');
      return ec2(cmd);
    });

    await expect(handler(deleteEvent)).rejects.toThrow('AccessDenied');
    expect(terminated()).toEqual([]);
  });

  test('an ENI that is already deleted does not fail the cleanup', async () => {
    workstations();
    enis = [{ NetworkInterfaceId: 'eni-example', Status: 'available', Description: 'AWS Lambda VPC ENI' }];
    mockEc2Send.mockImplementation(async (cmd: Command) => {
      if (cmd.name === 'DeleteNetworkInterface') {
        enis = [];
        throw awsError('InvalidNetworkInterfaceID.NotFound');
      }
      return ec2(cmd);
    });

    await expect(handler(deleteEvent)).resolves.toBeDefined();
  });

  test('does nothing on Create', async () => {
    await expect(handler({ ...deleteEvent, RequestType: 'Create' })).resolves.toBeDefined();
    expect(mockEc2Send).not.toHaveBeenCalled();
  });
});
