// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Join Domain on Windows workstations: instance-create-windows stores the
 * choice, the FSx SMB mount manager and start-instance read it, and records
 * that predate the field are resolved instead of being treated as standalone.
 * AWS SDK clients are mocked.
 */

import { spawnSync } from 'child_process';
import * as path from 'path';

const AD_PASSWORD = 'ad-service-account-test-pw'; // pragma: allowlist secret
const INSTANCE_ID = 'i-0123456789abcdef0';

type Call = { kind: string; input: any };
const mockCalls: Call[] = [];
const mockState: { workstation: any; computerName: string | null; ssmLookupFails: boolean } = {
  workstation: null, computerName: null, ssmLookupFails: false,
};

function mockCommand(kind: string) {
  return class {
    kind = kind;
    constructor(public input: any) {}
  };
}

jest.mock('@aws-sdk/client-dynamodb', () => ({ DynamoDBClient: class {} }), { virtual: true });
jest.mock('@aws-sdk/lib-dynamodb', () => ({
  GetCommand: mockCommand('Get'),
  PutCommand: mockCommand('Put'),
  QueryCommand: mockCommand('Query'),
  ScanCommand: mockCommand('Scan'),
  UpdateCommand: mockCommand('Update'),
  DynamoDBDocumentClient: {
    from: () => ({
      send: async (cmd: Call) => {
        mockCalls.push(cmd);
        if (cmd.kind === 'Get' && cmd.input.TableName === 'mrm-workstations') return { Item: mockState.workstation };
        if (cmd.kind === 'Get' && cmd.input.TableName === 'mrm-storage') {
          return { Item: { storageId: 'st-win', type: 'fsx-windows', name: 'Media', fsxDnsName: 'amznfsx.example.internal' } };
        }
        if (cmd.kind === 'Update' && cmd.input.TableName === 'mrm-hostname-counter') return { Attributes: { counter: 7 } };
        return {};
      },
    }),
  },
}), { virtual: true });

jest.mock('@aws-sdk/client-ssm', () => ({
  GetParameterCommand: mockCommand('GetParameter'),
  SendCommandCommand: mockCommand('SendCommand'),
  DescribeInstanceInformationCommand: mockCommand('DescribeInstanceInformation'),
  SSMClient: class {
    async send(cmd: Call) {
      mockCalls.push(cmd);
      if (cmd.kind === 'SendCommand') return { Command: { CommandId: 'cmd-1' } };
      if (cmd.kind === 'DescribeInstanceInformation') {
        if (mockState.ssmLookupFails) throw Object.assign(new Error('denied'), { name: 'AccessDeniedException' });
        return { InstanceInformationList: mockState.computerName ? [{ ComputerName: mockState.computerName }] : [] };
      }
      const values: Record<string, string> = {
        '/MediaResourceManager/Identity/ActiveDirectoryDomainName': 'studio.example.internal',
        '/MediaResourceManager/Identity/AdServiceAccountSecretArn': 'ad-secret', // pragma: allowlist secret
      };
      if (!(cmd.input.Name in values)) throw Object.assign(new Error('ParameterNotFound'), { name: 'ParameterNotFound' });
      return { Parameter: { Value: values[cmd.input.Name] } };
    }
  },
}), { virtual: true });

jest.mock('@aws-sdk/client-ec2', () => ({
  DescribeInstancesCommand: mockCommand('DescribeInstances'),
  DescribeImagesCommand: mockCommand('DescribeImages'),
  RunInstancesCommand: mockCommand('RunInstances'),
  EC2Client: class {
    async send(cmd: Call) {
      mockCalls.push(cmd);
      if (cmd.kind === 'RunInstances') return { Instances: [{ InstanceId: INSTANCE_ID }] };
      if (cmd.kind === 'DescribeImages') return { Images: [] };
      return { Reservations: [{ Instances: [{ State: { Name: 'running' } }] }] };
    }
  },
}), { virtual: true });

jest.mock('@aws-sdk/client-fsx', () => ({
  DescribeStorageVirtualMachinesCommand: mockCommand('DescribeSvm'),
  FSxClient: class { async send() { return {}; } },
}), { virtual: true });

jest.mock('@aws-sdk/client-secrets-manager', () => ({
  GetSecretValueCommand: mockCommand('GetSecretValue'),
  SecretsManagerClient: class {
    async send(cmd: Call) {
      mockCalls.push(cmd);
      return { SecretString: JSON.stringify({ username: 'svc-mrm', password: AD_PASSWORD }) };
    }
  },
}), { virtual: true });

process.env.STORAGE_TABLE_NAME = 'mrm-storage';
process.env.WORKSTATION_TABLE_NAME = 'mrm-workstations';
process.env.HOSTNAME_COUNTER_TABLE_NAME = 'mrm-hostname-counter';
process.env.PASCAL_CASE_NAME = 'MediaResourceManager';
process.env.AWS_REGION = 'us-east-1';
process.env.SUBNET_IDS = 'subnet-a,subnet-b';
process.env.LAUNCH_TEMPLATE_ID = 'lt-0123456789';

// eslint-disable-next-line @typescript-eslint/no-var-requires
const createWindows = require('../lambda/instance-create-windows/index.js');
// eslint-disable-next-line @typescript-eslint/no-var-requires
const mountManager = require('../lambda/fsx-smb-mount-manager/index.js');

const calls = (kind: string) => mockCalls.filter((c) => c.kind === kind);

beforeEach(() => {
  mockCalls.length = 0;
  mockState.computerName = null;
  mockState.ssmLookupFails = false;
  delete process.env.DEFAULT_WINDOWS_JOIN_DOMAIN;
  for (const level of ['log', 'warn', 'error'] as const) jest.spyOn(console, level).mockImplementation(() => undefined);
});

afterEach(() => jest.restoreAllMocks());

describe('instance-create-windows', () => {
  const create = (joinDomain: boolean) => createWindows.handler({
    amiId: 'ami-12345678', instanceType: 't3.large', assignedUserId: 'alice', joinDomain,
  });
  const storedRecord = () => {
    const puts = calls('Put').filter((c) => c.input.TableName === 'mrm-workstations');
    expect(puts).toHaveLength(1);
    return puts[0].input.Item;
  };

  test('stores joinDomain true for a domain-joined workstation', async () => {
    await create(true);
    expect(storedRecord()).toMatchObject({ instanceId: INSTANCE_ID, platform: 'Windows', joinDomain: true });
  });

  test('stores joinDomain false for a standalone workstation', async () => {
    await create(false);
    expect(storedRecord().joinDomain).toBe(false);
  });
});

describe('fsx-smb-mount-manager domain membership', () => {
  const unrecorded = () => ({
    instanceId: INSTANCE_ID, platform: 'Windows', storageConfig: { 'st-win': { autoMount: true, driveLetter: 'Z' } },
  });
  const script = () => (calls('SendCommand')[0].input.Parameters.commands as string[]).join('\n');
  const update = () => calls('Update').filter((c) => c.input.TableName === 'mrm-workstations');

  test('a recorded joinDomain true mounts with integrated auth and reads no AD secret', async () => {
    mockState.workstation = { ...unrecorded(), joinDomain: true };
    const result = await mountManager.handler({ action: 'updateInstance', instanceId: INSTANCE_ID });
    expect(result.isDomainJoined).toBe(true);
    expect(calls('GetSecretValue')).toHaveLength(0);
    expect(calls('DescribeInstanceInformation')).toHaveLength(0);
    expect(script()).toContain('Domain-joined - using integrated auth');
    expect(script()).not.toContain(AD_PASSWORD);
  });

  test('an unrecorded workstation whose computer name is in the AD domain is domain-joined, and the answer is stored', async () => {
    mockState.workstation = unrecorded();
    mockState.computerName = 'VDI-0001.Studio.Example.Internal';
    const result = await mountManager.handler({ action: 'updateInstance', instanceId: INSTANCE_ID });
    expect(result.isDomainJoined).toBe(true);
    expect(calls('GetSecretValue')).toHaveLength(0);
    expect(script()).not.toContain(AD_PASSWORD);
    expect(update()).toHaveLength(1);
    expect(update()[0].input).toMatchObject({
      Key: { instanceId: INSTANCE_ID },
      UpdateExpression: 'SET joinDomain = :joinDomain',
      ConditionExpression: 'attribute_exists(instanceId) AND attribute_not_exists(joinDomain)',
      ExpressionAttributeValues: { ':joinDomain': true },
    });
  });

  test('an unrecorded workstation outside the AD domain is standalone, and the answer is stored', async () => {
    mockState.workstation = unrecorded();
    mockState.computerName = 'VDI-0002';
    const result = await mountManager.handler({ action: 'updateInstance', instanceId: INSTANCE_ID });
    expect(result.isDomainJoined).toBe(false);
    expect(update()[0].input.ExpressionAttributeValues).toEqual({ ':joinDomain': false });
  });

  test('a computer name that only contains the domain as a prefix is not domain-joined', async () => {
    mockState.workstation = unrecorded();
    mockState.computerName = 'studio.example.internal.attacker.test';
    const result = await mountManager.handler({ action: 'updateInstance', instanceId: INSTANCE_ID });
    expect(result.isDomainJoined).toBe(false);
  });

  test.each([
    ['true', true],
    ['false', false],
  ])('when the lookup fails, DEFAULT_WINDOWS_JOIN_DOMAIN=%s decides and nothing is stored', async (value, expected) => {
    process.env.DEFAULT_WINDOWS_JOIN_DOMAIN = value;
    mockState.workstation = unrecorded();
    mockState.ssmLookupFails = true;
    const result = await mountManager.handler({ action: 'updateInstance', instanceId: INSTANCE_ID });
    expect(result.isDomainJoined).toBe(expected);
    expect(update()).toHaveLength(0);
    if (expected) expect(calls('GetSecretValue')).toHaveLength(0);
  });

  test('an unrecorded workstation with no SSM record uses the default', async () => {
    process.env.DEFAULT_WINDOWS_JOIN_DOMAIN = 'true';
    mockState.workstation = unrecorded();
    const result = await mountManager.handler({ action: 'updateInstance', instanceId: INSTANCE_ID });
    expect(result.isDomainJoined).toBe(true);
    expect(update()).toHaveLength(0);
  });

  test('a domainId still means domain-joined', async () => {
    mockState.workstation = { ...unrecorded(), domainId: 'd-1234567890' };
    const result = await mountManager.handler({ action: 'updateInstance', instanceId: INSTANCE_ID });
    expect(result.isDomainJoined).toBe(true);
    expect(calls('DescribeInstanceInformation')).toHaveLength(0);
  });
});

describe('start-instance', () => {
  test('Python unit tests pass', () => {
    const result = spawnSync('python3', ['-m', 'unittest', path.join(__dirname, 'python', 'test_start_instance_join_domain.py')], {
      encoding: 'utf8',
    });
    expect(result.stderr).toMatch(/\nOK\s*$/);
    expect(result.status).toBe(0);
  });
});
