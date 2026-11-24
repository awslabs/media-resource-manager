// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * FSx SMB mount manager: the credentials a workstation's SMB mounts need go
 * into that workstation's own secret, pinned to it by a resource policy. The
 * Run Command and the logon script carry only the secret ARN, and the script
 * maps the drive with New-PSDrive -Persist and a PSCredential. The AWS SDK
 * clients are mocked.
 */

export {};

const AD_PASSWORD = 'ad-service-account-test-pw'; // pragma: allowlist secret
const ONTAP_ADMIN_PASSWORD = 'ontap-admin-test-pw'; // pragma: allowlist secret
const SMB_PASSWORD = 'ontap-smb-user-test-pw'; // pragma: allowlist secret
const INSTANCE_ID = 'i-0123456789abcdef0';
const ROLE_ARN = 'arn:aws:iam::123456789012:role/Mrm-Dcv-WorkstationInstanceRole';
const SECRET_ARN = `arn:aws:secretsmanager:us-east-1:123456789012:secret:/MediaResourceManager/Workstation/${INSTANCE_ID}/SmbMount-AbCdEf`; // pragma: allowlist secret

type Call = { kind: string; input: any };
const mockCalls: Call[] = [];
const mockState: {
  workstation: any;
  storage: Record<string, any>;
  secretExists: boolean;
  failPutSecret: boolean;
  // CreateSecret calls that fail with "scheduled for deletion" after a delete
  // (the name stays reserved while Secrets Manager removes the secret).
  purgeAttempts: number;
  pendingDeletion: number;
  createFailure: string | null;
} = { workstation: null, storage: {}, secretExists: false, failPutSecret: false, purgeAttempts: 0, pendingDeletion: 0, createFailure: null };

function mockCommand(kind: string) {
  return class {
    kind = kind;
    constructor(public input: any) {}
  };
}

jest.mock('@aws-sdk/client-dynamodb', () => ({ DynamoDBClient: class {} }), { virtual: true });
jest.mock('@aws-sdk/lib-dynamodb', () => ({
  GetCommand: mockCommand('Get'),
  ScanCommand: mockCommand('Scan'),
  DynamoDBDocumentClient: {
    from: () => ({
      send: async (cmd: Call) => {
        if (cmd.kind === 'Get' && cmd.input.TableName === 'mrm-workstations') return { Item: mockState.workstation };
        if (cmd.kind === 'Get' && cmd.input.TableName === 'mrm-storage') return { Item: mockState.storage[cmd.input.Key.storageId] };
        return { Items: [] };
      },
    }),
  },
}), { virtual: true });

jest.mock('@aws-sdk/client-ssm', () => ({
  GetParameterCommand: mockCommand('GetParameter'),
  SendCommandCommand: mockCommand('SendCommand'),
  SSMClient: class {
    async send(cmd: Call) {
      mockCalls.push(cmd);
      if (cmd.kind === 'SendCommand') return { Command: { CommandId: 'cmd-1' } };
      const values: Record<string, string> = {
        '/MediaResourceManager/Identity/ActiveDirectoryDomainName': 'example.internal',
        '/MediaResourceManager/Identity/AdServiceAccountSecretArn': 'ad-secret', // pragma: allowlist secret
        '/MediaResourceManager/DCV/InstanceRoleArn': ROLE_ARN,
      };
      return { Parameter: { Value: values[cmd.input.Name] } };
    }
  },
}), { virtual: true });

jest.mock('@aws-sdk/client-ec2', () => ({
  DescribeInstancesCommand: mockCommand('DescribeInstances'),
  EC2Client: class {
    async send() {
      return { Reservations: [{ Instances: [{ State: { Name: 'running' } }] }] };
    }
  },
}), { virtual: true });

jest.mock('@aws-sdk/client-fsx', () => ({
  DescribeStorageVirtualMachinesCommand: mockCommand('DescribeSvm'),
  FSxClient: class {
    async send() {
      return { StorageVirtualMachines: [{ Endpoints: { Smb: { DNSName: 'svm.example.internal' } } }] };
    }
  },
}), { virtual: true });

jest.mock('@aws-sdk/client-secrets-manager', () => {
  const error = (name: string) => Object.assign(new Error(name), { name });
  return {
    GetSecretValueCommand: mockCommand('GetSecretValue'),
    CreateSecretCommand: mockCommand('CreateSecret'),
    PutSecretValueCommand: mockCommand('PutSecretValue'),
    PutResourcePolicyCommand: mockCommand('PutResourcePolicy'),
    DeleteSecretCommand: mockCommand('DeleteSecret'),
    SecretsManagerClient: class {
      async send(cmd: Call) {
        mockCalls.push(cmd);
        switch (cmd.kind) {
          case 'GetSecretValue':
            if (cmd.input.SecretId === 'ad-secret') { // pragma: allowlist secret
              return { SecretString: JSON.stringify({ username: 'svc-mrm', password: AD_PASSWORD }) };
            }
            return {
              SecretString: JSON.stringify({
                username: 'fsxadmin', password: ONTAP_ADMIN_PASSWORD,
                smbUser: 'mrm-smb', smbPassword: SMB_PASSWORD, shareName: 'media',
              }),
            };
          case 'CreateSecret':
            if (mockState.createFailure) {
              throw Object.assign(new Error(mockState.createFailure), { name: 'InvalidRequestException' });
            }
            if (mockState.pendingDeletion > 0) {
              mockState.pendingDeletion--;
              throw Object.assign(
                new Error("You can't create this secret because a secret with this name is already scheduled for deletion."),
                { name: 'InvalidRequestException' },
              );
            }
            if (mockState.secretExists) throw error('ResourceExistsException');
            mockState.secretExists = true;
            return { ARN: SECRET_ARN };
          case 'PutSecretValue':
            if (mockState.failPutSecret) throw error('AccessDeniedException');
            return { ARN: SECRET_ARN };
          case 'DeleteSecret':
            if (!mockState.secretExists) throw error('ResourceNotFoundException');
            mockState.secretExists = false;
            mockState.pendingDeletion = mockState.purgeAttempts;
            return {};
          default:
            return {};
        }
      }
    },
  };
}, { virtual: true });

process.env.STORAGE_TABLE_NAME = 'mrm-storage';
process.env.WORKSTATION_TABLE_NAME = 'mrm-workstations';
process.env.PASCAL_CASE_NAME = 'MediaResourceManager';
process.env.ACRONYM = 'MRM';
process.env.AWS_REGION = 'us-east-1';

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { handler } = require('../lambda/fsx-smb-mount-manager/index.js');

const logged: string[] = [];
const delays: number[] = [];
const calls = (kind: string) => mockCalls.filter((c) => c.kind === kind);
const sentScript = () => {
  const sent = calls('SendCommand');
  expect(sent).toHaveLength(1);
  return (sent[0].input.Parameters.commands as string[]).join('\n');
};
const expectNoPassword = (text: string) => {
  for (const pw of [AD_PASSWORD, ONTAP_ADMIN_PASSWORD, SMB_PASSWORD]) expect(text).not.toContain(pw);
};

const FSX_WINDOWS = { storageId: 'st-win', type: 'fsx-windows', name: 'Media', fsxDnsName: 'amznfsx.example.internal' };
const FSX_ONTAP = { storageId: 'st-ontap', type: 'fsx-ontap', name: 'Projects', svmId: 'svm-1' };

function workstation(joinDomain: boolean, storageIds: string[]) {
  return {
    instanceId: INSTANCE_ID,
    platform: 'windows',
    joinDomain,
    ...(joinDomain ? { domainId: 'd-1234567890' } : {}),
    storageConfig: Object.fromEntries(storageIds.map((id, i) => [id, { autoMount: true, driveLetter: 'ZY'[i] }])),
  };
}

beforeEach(() => {
  mockCalls.length = 0;
  logged.length = 0;
  delays.length = 0;
  mockState.secretExists = false;
  mockState.failPutSecret = false;
  mockState.purgeAttempts = 0;
  mockState.pendingDeletion = 0;
  mockState.createFailure = null;
  mockState.storage = { 'st-win': FSX_WINDOWS, 'st-ontap': FSX_ONTAP };
  // Run retry back-offs at once and record their lengths.
  jest.spyOn(global, 'setTimeout').mockImplementation(((fn: () => void, ms?: number) => {
    delays.push(ms ?? 0);
    fn();
    return 0;
  }) as any);
  for (const level of ['log', 'warn', 'error'] as const) {
    jest.spyOn(console, level).mockImplementation((...args: unknown[]) => {
      logged.push(args.map((a) => (typeof a === 'string' ? a : JSON.stringify(a))).join(' '));
    });
  }
});

afterEach(() => jest.restoreAllMocks());

describe('standalone workstation with FSx for Windows', () => {
  beforeEach(() => {
    mockState.workstation = workstation(false, ['st-win']);
  });

  test('the Run Command and the logon script carry no password', async () => {
    await handler({ action: 'updateInstance', instanceId: INSTANCE_ID });
    const script = sentScript();
    expectNoPassword(script);
    expect(script).not.toMatch(/net use [^\n]*\/user:/);
    expect(script).not.toMatch(/\$password\b/);
  });

  test('the script reads the workstation secret and maps the drive with New-PSDrive -Persist', async () => {
    await handler({ action: 'updateInstance', instanceId: INSTANCE_ID });
    const script = sentScript();
    expect(script).toContain(`$secretArn = '${SECRET_ARN}'`);
    expect(script).toContain("$secretRegion = 'us-east-1'"); // pragma: allowlist secret
    expect(script).toContain('Get-SECSecretValue -SecretId $secretArn -Region $secretRegion -ErrorAction Stop');
    expect(script).toContain("Get-MountCredential 'st-win'");
    expect(script).toMatch(/New-PSDrive -Name "Z" -PSProvider FileSystem -Root \$networkPath -Credential \$mountCredential -Persist -Scope Global -ErrorAction Stop/);
    // New-SmbMapping bypasses the network provider, so Explorer does not show its drives.
    expect(script).not.toContain('New-SmbMapping');
    expect(script).not.toContain('GetNetworkCredential');
    expect(script).not.toMatch(/net use [^\n]*\/user:/);
  });

  test('the drive label goes to the MountPoints2 key Explorer reads (##server#share)', async () => {
    await handler({ action: 'updateInstance', instanceId: INSTANCE_ID });
    const script = sentScript();
    // $networkPath is \\server\share; replacing \ with # gives ##server#share.
    expect(script).toContain("Explorer\\MountPoints2\\$($networkPath.Replace('\\', '#'))");
    expect(script).not.toContain('MountPoints2\\##');
    expect(script).toContain('New-Object System.Management.Automation.PSCredential');
    expect(script).toContain('Remove-Variable -Name mountCredentials, mountCredential');
  });

  test('the secret gets its resource policy before the credentials are written', async () => {
    await handler({ action: 'updateInstance', instanceId: INSTANCE_ID });
    const kinds = mockCalls.filter((c) => ['CreateSecret', 'PutResourcePolicy', 'PutSecretValue'].includes(c.kind)).map((c) => c.kind);
    expect(kinds).toEqual(['CreateSecret', 'PutResourcePolicy', 'PutSecretValue']);
    const create = calls('CreateSecret')[0].input;
    expect(create.Name).toBe(`/MediaResourceManager/Workstation/${INSTANCE_ID}/SmbMount`);
    expect(create.SecretString).toBe('{}');
    const value = JSON.parse(calls('PutSecretValue')[0].input.SecretString);
    expect(value).toEqual({ version: 1, mounts: { 'st-win': { username: 'example.internal\\svc-mrm', password: AD_PASSWORD } } });
  });

  test('the resource policy pins reads to this instance and the workstation roles', async () => {
    await handler({ action: 'updateInstance', instanceId: INSTANCE_ID });
    const put = calls('PutResourcePolicy')[0].input;
    expect(put.SecretId).toBe(SECRET_ARN);
    expect(put.BlockPublicPolicy).toBe(true);
    const policy = JSON.parse(put.ResourcePolicy);
    expect(policy.Statement).toEqual([
      expect.objectContaining({
        Effect: 'Deny', Principal: '*', Action: 'secretsmanager:GetSecretValue',
        Condition: { StringNotLike: { 'aws:userid': `*:${INSTANCE_ID}` } },
      }),
      expect.objectContaining({
        Effect: 'Deny', Principal: '*', Action: 'secretsmanager:GetSecretValue',
        Condition: {
          ArnNotLike: {
            'aws:PrincipalArn': [
              ROLE_ARN,
              'arn:aws:iam::123456789012:role/MediaResourceManager-Regional-Workstation-Role',
              'arn:aws:iam::123456789012:role/MediaResourceManager-Regional-Workstation-Role-*',
              'arn:aws:iam::123456789012:role/MRM-Regional-Workstation-Role-*',
            ],
          },
        },
      }),
    ]);
    expect(policy.Statement.some((s: any) => s.Effect === 'Allow')).toBe(false);
  });

  test('an existing secret is updated in place', async () => {
    mockState.secretExists = true;
    await handler({ action: 'updateInstance', instanceId: INSTANCE_ID });
    expect(calls('PutResourcePolicy')[0].input.SecretId).toBe(`/MediaResourceManager/Workstation/${INSTANCE_ID}/SmbMount`);
    expect(calls('PutSecretValue')).toHaveLength(1);
  });

  test('when the secret cannot be written the run fails and no script is sent', async () => {
    mockState.failPutSecret = true;
    await expect(handler({ action: 'updateInstance', instanceId: INSTANCE_ID }))
      .rejects.toThrow(`Could not write the SMB mount secret for ${INSTANCE_ID}: AccessDeniedException`);
    expect(calls('SendCommand')).toHaveLength(0);
  });

  test('the secret is read with the fastest client present, and the read is timed in the log', async () => {
    await handler({ action: 'updateInstance', instanceId: INSTANCE_ID });
    const script = sentScript();
    const modular = script.indexOf('Get-Module -ListAvailable -Name AWS.Tools.SecretsManager');
    const cli = script.indexOf('Get-Command aws.exe');
    const monolithic = script.indexOf("$readClient = 'AWSPowerShell'");
    expect(modular).toBeGreaterThan(-1);
    expect(cli).toBeGreaterThan(modular);
    expect(monolithic).toBeGreaterThan(cli);
    // The CLI gets only the ARN and Region; the value goes to a variable, not a file.
    expect(script).toContain('& aws.exe secretsmanager get-secret-value --secret-id $secretArn --region $secretRegion --query SecretString --output text');
    expect(script).not.toMatch(/get-secret-value[^\n]*(>|Out-File|Set-Content)/);
    expect(script).toContain('Read the SMB mount credentials with $readClient in');
  });

  test('every log line gets the time it is written', async () => {
    await handler({ action: 'updateInstance', instanceId: INSTANCE_ID });
    const script = sentScript();
    expect(script).not.toContain('$timestamp');
    const lines = script.split('\n').filter((l) => l.includes('Add-Content -Path $logFile'));
    expect(lines.length).toBeGreaterThan(3);
    for (const line of lines) expect(line).toContain('[$(Get-LogTime)]');
    // The start line comes before the credential read.
    expect(script.indexOf('Starting FSx mount')).toBeLessThan(script.indexOf('$readStart = Get-Date'));
  });

  test('the Run Command queues task starts and fails if the task cannot start', async () => {
    await handler({ action: 'updateInstance', instanceId: INSTANCE_ID });
    const command = sentScript();
    const queue = command.indexOf('$task.Settings.MultipleInstances = "Queue"');
    const setTask = command.indexOf('Set-ScheduledTask -InputObject $task -ErrorAction Stop');
    const start = command.indexOf('Start-ScheduledTask -TaskName "FSxMountScript" -ErrorAction Stop');
    expect(command).toContain('Get-ScheduledTask -TaskName "FSxMountScript" -ErrorAction Stop');
    expect(queue).toBeGreaterThan(-1);
    expect(setTask).toBeGreaterThan(queue);
    expect(start).toBeGreaterThan(setTask);
    // The script file is written before the task is started.
    expect(command.indexOf('$scriptContent | Out-File $scriptFile')).toBeLessThan(start);
    expect(command).not.toMatch(/Start-ScheduledTask[^\n]*SilentlyContinue/);
    expect(command).toContain('Write-Error "Could not start the FSxMountScript task: $($_.Exception.Message)"');
    expect(command.slice(start)).toMatch(/catch \{[^}]*exit 1/);
  });

  test('the log says "completed with errors" when a mount failed', async () => {
    await handler({ action: 'updateInstance', instanceId: INSTANCE_ID });
    const script = sentScript();
    expect(script).toContain('$mountErrors = 0');
    expect(script).toMatch(/\$mountErrors\+\+\s*\n\s*Add-Content -Path \$logFile -Value "\[\$\(Get-LogTime\)\] ERROR: Failed to mount Media/);
    expect(script).toContain('if ($mountErrors -gt 0) {');
    expect(script).toContain('FSx mount completed with errors ($mountErrors failed) for user: $env:USERNAME');
  });

  test('no log line carries a password', async () => {
    await handler({ action: 'updateInstance', instanceId: INSTANCE_ID });
    mockState.failPutSecret = true;
    await expect(handler({ action: 'updateInstance', instanceId: INSTANCE_ID })).rejects.toThrow();
    expect(logged.length).toBeGreaterThan(0);
    for (const line of logged) expectNoPassword(line);
  });
});

describe('attach, detach and attach again', () => {
  const attached = () => workstation(false, ['st-win']);
  const detached = () => ({ ...workstation(false, []), storageConfig: { 'st-win': { autoMount: false, driveLetter: 'Z' } } });

  test('a re-attach while the deleted secret is still being removed waits, then writes the credentials', async () => {
    mockState.purgeAttempts = 2;
    mockState.workstation = attached();
    await handler({ action: 'updateInstance', instanceId: INSTANCE_ID });
    mockState.workstation = detached();
    await handler({ action: 'updateInstance', instanceId: INSTANCE_ID });
    expect(calls('DeleteSecret')).toHaveLength(1);
    mockCalls.length = 0;

    mockState.workstation = attached();
    await handler({ action: 'updateInstance', instanceId: INSTANCE_ID });
    expect(calls('CreateSecret')).toHaveLength(3);
    expect(delays).toEqual([1000, 2000]);
    expect(calls('PutSecretValue')).toHaveLength(1);
    const script = sentScript();
    expect(script).toContain(`$secretArn = '${SECRET_ARN}'`);
    expect(script).toContain("Get-MountCredential 'st-win'");
    expect(script).not.toContain('CREDENTIALS NOT AVAILABLE');
    expectNoPassword(script);
  });

  test('when the name stays reserved past the retries, the run fails and no script is sent', async () => {
    mockState.pendingDeletion = 100;
    mockState.workstation = attached();
    await expect(handler({ action: 'updateInstance', instanceId: INSTANCE_ID }))
      .rejects.toThrow(`Could not write the SMB mount secret for ${INSTANCE_ID}: InvalidRequestException`);
    expect(calls('CreateSecret')).toHaveLength(5);
    expect(delays).toEqual([1000, 2000, 4000, 8000]);
    expect(calls('PutSecretValue')).toHaveLength(0);
    expect(calls('SendCommand')).toHaveLength(0);
  });

  test('other CreateSecret errors are not retried', async () => {
    mockState.createFailure = 'The parameter Name is not valid.';
    mockState.workstation = attached();
    await expect(handler({ action: 'updateInstance', instanceId: INSTANCE_ID }))
      .rejects.toThrow('InvalidRequestException');
    expect(calls('CreateSecret')).toHaveLength(1);
    expect(delays).toEqual([]);
    expect(calls('SendCommand')).toHaveLength(0);
  });
});

describe('domain-joined workstation', () => {
  test('FSx for Windows uses integrated auth, with no secret and no credential in the script', async () => {
    mockState.workstation = workstation(true, ['st-win']);
    mockState.secretExists = true; // left over from when it was standalone
    await handler({ action: 'updateInstance', instanceId: INSTANCE_ID });
    expect(calls('CreateSecret')).toHaveLength(0);
    expect(calls('DeleteSecret')).toHaveLength(1);
    expect(calls('GetSecretValue')).toHaveLength(0);
    const script = sentScript();
    expectNoPassword(script);
    expect(script).toContain('Domain-joined - using integrated auth');
    expect(script).not.toContain('New-PSDrive');
  });

  test('FSx for ONTAP gets only the SMB user, never the ONTAP admin credentials', async () => {
    mockState.workstation = workstation(true, ['st-ontap']);
    await handler({ action: 'updateInstance', instanceId: INSTANCE_ID });
    const value = JSON.parse(calls('PutSecretValue')[0].input.SecretString);
    expect(value).toEqual({ version: 1, mounts: { 'st-ontap': { username: 'mrm-smb', password: SMB_PASSWORD } } });
    const script = sentScript();
    expectNoPassword(script);
    expect(script).toContain("Get-MountCredential 'st-ontap'");
    expect(script).toContain('$networkPath = "\\\\svm.example.internal\\media"');
  });
});

describe('secret cleanup', () => {
  test('a workstation with no storage has its secret removed', async () => {
    mockState.workstation = { instanceId: INSTANCE_ID, platform: 'windows', joinDomain: false };
    mockState.secretExists = true;
    await handler({ action: 'updateInstance', instanceId: INSTANCE_ID });
    expect(calls('DeleteSecret')[0].input).toEqual({
      SecretId: `/MediaResourceManager/Workstation/${INSTANCE_ID}/SmbMount`,
      ForceDeleteWithoutRecovery: true,
    });
  });

  test('removeInstance deletes the secret, and a missing secret is not an error', async () => {
    mockState.secretExists = true;
    await expect(handler({ action: 'removeInstance', instanceId: INSTANCE_ID })).resolves.toEqual({ success: true, instanceId: INSTANCE_ID });
    await expect(handler({ action: 'removeInstance', instanceId: INSTANCE_ID })).resolves.toEqual({ success: true, instanceId: INSTANCE_ID });
    expect(calls('DeleteSecret')).toHaveLength(2);
  });

  test.each(['../../Identity/x', 'i-123', '', 'i-0123456789abcdef0/../x'])(
    'instance ID %j is rejected before any secret call',
    async (instanceId) => {
      await expect(handler({ action: 'removeInstance', instanceId })).rejects.toThrow('Invalid instanceId');
      await expect(handler({ action: 'updateInstance', instanceId })).rejects.toThrow('Invalid instanceId');
      expect(mockCalls.filter((c) => c.kind !== 'GetParameter')).toHaveLength(0);
    },
  );
});

describe('workstation-manager delete', () => {
  test('requests SMB mount secret cleanup for the deleted workstation', () => {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const fs = require('fs');
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const path = require('path');
    const src: string = fs.readFileSync(path.join(__dirname, '..', 'lambda', 'workstation-manager', 'index.js'), 'utf8');
    const body = src.slice(src.indexOf('async function deleteWorkstation'), src.indexOf('async function startWorkstation'));
    expect(body).toMatch(/action: 'removeInstance', instanceId/);
    expect(body.indexOf('removeInstance')).toBeLessThan(body.indexOf('DeleteCommand'));
  });
});
