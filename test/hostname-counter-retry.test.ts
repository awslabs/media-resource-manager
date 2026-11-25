// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * A failed launch doesn't use up a hostname number (#5).
 *
 * Windows and Linux: the creation state machine calls instance-create again
 * with the Lambda's own output after a capacity error, so the retry reuses
 * the reserved number, and the number goes back to the counter when the last
 * subnet fails. macOS tries every subnet in one call and gives the number
 * back when no instance launches. The AWS SDK clients and the hostname
 * counter table are mocked.
 */

export {};

type Call = { kind: string; input: any };
const mockCalls: Call[] = [];
const mockState: {
  counter: Map<string, number>;
  // Outcome of each RunInstances call, in order: 'ok' or an error name.
  launches: string[];
  failPut: boolean;
} = { counter: new Map(), launches: [], failPut: false };

function mockCommand(kind: string) {
  return class {
    kind = kind;
    constructor(public input: any) {}
  };
}

const awsError = (name: string, message = name) => Object.assign(new Error(message), { name });

jest.mock('@aws-sdk/client-dynamodb', () => ({ DynamoDBClient: class {} }), { virtual: true });
jest.mock('@aws-sdk/lib-dynamodb', () => ({
  PutCommand: mockCommand('Put'),
  QueryCommand: mockCommand('Query'),
  GetCommand: mockCommand('Get'),
  UpdateCommand: mockCommand('Update'),
  DynamoDBDocumentClient: {
    from: () => ({
      send: async (cmd: Call) => {
        mockCalls.push(cmd);
        if (cmd.kind === 'Update' && cmd.input.TableName === 'mrm-hostname-counters') {
          const key = cmd.input.Key.prefix;
          const v = cmd.input.ExpressionAttributeValues;
          if (cmd.input.ConditionExpression) {
            // Give-back: SET counter = :previous IF counter = :number
            if (mockState.counter.get(key) !== v[':number']) throw awsError('ConditionalCheckFailedException');
            mockState.counter.set(key, v[':previous']);
            return {};
          }
          const next = (mockState.counter.get(key) ?? v[':zero']) + v[':inc'];
          mockState.counter.set(key, next);
          return { Attributes: { counter: next } };
        }
        if (cmd.kind === 'Put' && mockState.failPut && cmd.input.TableName === 'mrm-workstations') {
          throw awsError('ProvisionedThroughputExceededException');
        }
        return {};
      },
    }),
  },
}), { virtual: true });
jest.mock('@aws-sdk/client-ssm', () => ({
  GetParameterCommand: mockCommand('GetParameter'),
  SSMClient: class {
    async send(cmd: Call) {
      if (cmd.input.Name.endsWith('/HostnamePrefix')) return { Parameter: { Value: 'ws-' } };
      if (cmd.input.Name.endsWith('/HostnameDigits')) return { Parameter: { Value: '4' } };
      return { Parameter: { Value: '' } };
    }
  },
}), { virtual: true });
jest.mock('@aws-sdk/client-ec2', () => ({
  RunInstancesCommand: mockCommand('RunInstances'),
  DescribeImagesCommand: mockCommand('DescribeImages'),
  DescribeHostsCommand: mockCommand('DescribeHosts'),
  AllocateHostsCommand: mockCommand('AllocateHosts'),
  DescribeSubnetsCommand: mockCommand('DescribeSubnets'),
  EC2Client: class {
    async send(cmd: Call) {
      mockCalls.push(cmd);
      if (cmd.kind !== 'RunInstances') return { Images: [], Hosts: [], Subnets: [] };
      const outcome = mockState.launches.shift() ?? 'ok';
      if (outcome === 'ok') {
        const n = mockCalls.filter(c => c.kind === 'RunInstances').length;
        return { Instances: [{ InstanceId: `i-${String(n).padStart(17, '0')}`, Placement: { AvailabilityZone: 'us-east-1b' } }] };
      }
      if (outcome === 'MacHostUnavailable') {
        throw awsError('InvalidParameterValue', 'The requested configuration is currently not supported. Please check the documentation for supported configurations.');
      }
      throw awsError(outcome);
    }
  },
}), { virtual: true });
jest.mock('@aws-sdk/client-resource-groups', () => ({
  ResourceGroupsClient: class { async send() { return {}; } },
  GroupResourcesCommand: mockCommand('GroupResources'),
  ListGroupResourcesCommand: mockCommand('ListGroupResources'),
  GetGroupConfigurationCommand: mockCommand('GetGroupConfiguration'),
}), { virtual: true });
jest.mock('@aws-sdk/client-license-manager', () => ({
  LicenseManagerClient: class { async send() { return {}; } },
  UpdateLicenseSpecificationsForResourceCommand: mockCommand('UpdateLicenseSpecifications'),
}), { virtual: true });

Object.assign(process.env, {
  AWS_REGION: 'us-east-1',
  PASCAL_CASE_NAME: 'MediaResourceManager',
  HOSTNAME_COUNTER_TABLE_NAME: 'mrm-hostname-counters',
  WORKSTATION_TABLE_NAME: 'mrm-workstations',
  IMAGE_PIPELINES_TABLE_NAME: 'mrm-image-pipelines',
  IMAGES_TABLE_NAME: 'mrm-images',
  SUBNET_IDS: 'subnet-0a,subnet-0b,subnet-0c',
  LAUNCH_TEMPLATE_ID: 'lt-0abc',
});

/* eslint-disable @typescript-eslint/no-var-requires */
const windows = require('../lambda/instance-create-windows/index.js');
const linux = require('../lambda/instance-create-linux/index.js');
/* eslint-enable @typescript-eslint/no-var-requires */

const counter = () => mockState.counter.get('ws-');
const nameTags = () => mockCalls
  .filter(c => c.kind === 'RunInstances')
  .map(c => c.input.TagSpecifications[0].Tags.find((t: any) => t.Key === 'Hostname')?.Value);
const savedHostname = () => mockCalls.find(c => c.kind === 'Put' && c.input.TableName === 'mrm-workstations' && c.input.Item.hostname)?.input.Item.hostname;

/** Run the create step the way the state machine does: retry with the Lambda's output while shouldRetry. */
async function createWithRetries(handler: (e: any) => Promise<any>, input: any) {
  let out = await handler(input);
  while (out.error && out.shouldRetry) out = await handler(out);
  return out;
}

beforeEach(() => {
  mockCalls.length = 0;
  mockState.counter = new Map([['ws-', 7]]);
  mockState.launches = [];
  mockState.failPut = false;
});

describe.each([
  ['Windows', windows.handler],
  ['Linux', linux.handler],
])('%s instance-create', (_platform, handler) => {
  const input = { amiId: 'ami-abc', instanceType: 'g5.xlarge', assignedUserId: 'alice' };

  test('reuses the reserved number when it retries after capacity errors', async () => {
    mockState.launches = ['InsufficientInstanceCapacity', 'Unsupported', 'ok'];
    const out = await createWithRetries(handler, input);
    expect(out.error).toBeUndefined();
    expect(out.hostname).toBe('ws-0008');
    expect(nameTags()).toEqual(['ws-0008', 'ws-0008', 'ws-0008']);
    expect(savedHostname()).toBe('ws-0008');
    expect(counter()).toBe(8);
  });

  test('passes the reservation to the next attempt only while it retries', async () => {
    mockState.launches = ['InsufficientInstanceCapacity'];
    const out = await handler(input);
    expect(out.shouldRetry).toBe(true);
    expect(out.hostnameReservation).toEqual({ hostname: 'ws-0008', hostnameNumber: 8, prefix: 'ws-' });
  });

  test('gives the number back when the last subnet has no capacity', async () => {
    mockState.launches = ['InsufficientInstanceCapacity', 'InsufficientInstanceCapacity', 'InsufficientInstanceCapacity'];
    const out = await createWithRetries(handler, input);
    expect(out.shouldRetry).toBe(false);
    expect(out.hostnameReservation).toBeNull();
    expect(counter()).toBe(7);
  });

  test('gives the number back when RunInstances fails with another error', async () => {
    mockState.launches = ['InvalidParameterCombination'];
    await expect(handler(input)).rejects.toThrow('InvalidParameterCombination');
    expect(counter()).toBe(7);
  });

  test('keeps the number when a step after the launch fails', async () => {
    mockState.failPut = true;
    await expect(handler(input)).rejects.toThrow('ProvisionedThroughputExceededException');
    expect(counter()).toBe(8);
  });

  test('leaves the counter alone when another create has taken a later number', async () => {
    mockState.launches = ['InsufficientInstanceCapacity', 'InsufficientInstanceCapacity'];
    let out = await handler(input);
    out = await handler(out);
    mockState.counter.set('ws-', 9); // another workstation got ws-0009 meanwhile
    mockState.launches = ['InsufficientInstanceCapacity'];
    out = await handler(out);
    expect(out.shouldRetry).toBe(false);
    expect(counter()).toBe(9);
  });
});

describe('macOS instance-create', () => {
  let mac: { handler: (e: any) => Promise<any> };
  beforeAll(() => {
    process.env.SUBNET_IDS = 'subnet-0a:us-east-1a,subnet-0b:us-east-1b';
    process.env.SECURITY_GROUP_ID = 'sg-0abc';
    process.env.INSTANCE_PROFILE_NAME = 'mrm-workstation-profile';
    delete process.env.HOST_RESOURCE_GROUP_ARN;
    jest.isolateModules(() => {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      mac = require('../lambda/instance-create-macos/index.js');
    });
  });
  const input = { amiId: 'ami-mac', instanceType: 'mac2.metal', assignedUserId: 'alice' };

  test('uses one number for all the subnets it tries', async () => {
    mockState.launches = ['MacHostUnavailable', 'ok'];
    await mac.handler(input);
    expect(nameTags()).toEqual(['ws-0008', 'ws-0008']);
    expect(counter()).toBe(8);
  });

  test('gives the number back when no instance launches', async () => {
    mockState.launches = ['MacHostUnavailable', 'MacHostUnavailable'];
    await expect(mac.handler(input)).rejects.toThrow(/No suitable mac2.metal host available/);
    expect(counter()).toBe(7);
  });
});
