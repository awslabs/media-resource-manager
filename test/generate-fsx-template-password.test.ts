// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0
/**
 * Unit tests for how lambda/generate-fsx-template handles credentials:
 * - FSx for ONTAP: the stack generates the admin credentials in Secrets
 *   Manager.
 * - FSx for Windows: the stack reads the AD service-account credentials from
 *   their secret through dynamic references.
 * In both cases neither the template nor the Lambda's return value (which
 * Step Functions records) carries a password.
 */
// Fixed fake AD service-account credentials, returned by the Secrets Manager
// mock if anything reads the AD secret.
const FAKE_AD_USERNAME = 'svc-fsx-unit-test';
const FAKE_AD_PASSWORD = 'not-a-real-ad-value-0000'; // pragma: allowlist secret
const AD_SECRET_ARN = 'arn:aws:secretsmanager:us-east-1:123456789012:secret:unit-test-ad'; // pragma: allowlist secret
const LEGACY_AD_SECRET_NAME = '/MediaResourceManager/Identity/ResourceAdminActiveDirectoryLoginCredentials';

// When false, the AdServiceAccountSecretArn SSM parameter doesn't exist.
let mockHasAdSecretArnParameter = true;

// The Lambda runtime provides this client. The repo doesn't install it.
jest.mock('@aws-sdk/client-secrets-manager', () => ({
  SecretsManagerClient: jest.fn(() => ({
    send: jest.fn(async () => ({ SecretString: JSON.stringify({ username: 'svc-fsx-unit-test', password: 'not-a-real-ad-value-0000' }) })),
  })),
  GetSecretValueCommand: jest.fn((input: unknown) => ({ input })),
}), { virtual: true });
jest.mock('@aws-sdk/client-ssm', () => ({
  SSMClient: jest.fn(() => ({
    send: jest.fn(async (command: { input: { Name: string } }) => {
      if (mockHasAdSecretArnParameter && command.input.Name.endsWith('/Identity/AdServiceAccountSecretArn')) {
        return { Parameter: { Value: 'arn:aws:secretsmanager:us-east-1:123456789012:secret:unit-test-ad' } };
      }
      throw Object.assign(new Error(`unexpected parameter ${command.input.Name}`), { name: 'ParameterNotFound' });
    }),
  })),
  GetParameterCommand: jest.fn((input: unknown) => ({ input })),
}), { virtual: true });

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { handler } = require('../lambda/generate-fsx-template/index.js');
// Output of the handler before the AD secret moved into dynamic references,
// for WINDOWS_EVENTS, captured with the same mocks. Only the AD credentials
// may differ from it (see withAdSecretReference).
// eslint-disable-next-line @typescript-eslint/no-var-requires
const WINDOWS_FIXTURE = require('./fixtures/generate-fsx-template-windows.json');
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { GetSecretValueCommand } = jest.requireMock('@aws-sdk/client-secrets-manager');

type StackParameter = { ParameterKey: string; ParameterValue: string };

const AD_USERNAME_REF = { 'Fn::Sub': '{{resolve:secretsmanager:${ADSecretId}:SecretString:username}}' };
const AD_PASSWORD_REF = { 'Fn::Sub': '{{resolve:secretsmanager:${ADSecretId}:SecretString:password}}' };

// The fixture with ADUsername/ADPassword replaced by the ADSecretId parameter
// and the dynamic references that read the secret.
function withAdSecretReference(fixture: { template: any; parameters: StackParameter[] }) {
  const expected = JSON.parse(JSON.stringify(fixture));
  delete expected.template.Parameters.ADUsername;
  delete expected.template.Parameters.ADPassword;
  expected.template.Parameters.ADSecretId = {
    Type: 'String',
    Default: AD_SECRET_ARN,
    Description: 'Name or ARN of the Secrets Manager secret that holds the Active Directory service account username and password',
  };
  const ad = expected.template.Resources.FsxFileSystem.Properties.WindowsConfiguration.SelfManagedActiveDirectoryConfiguration;
  ad.UserName = AD_USERNAME_REF;
  ad.Password = AD_PASSWORD_REF;
  expected.parameters = expected.parameters
    .filter((p: StackParameter) => p.ParameterKey !== 'ADUsername' && p.ParameterKey !== 'ADPassword')
    .concat([{ ParameterKey: 'ADSecretId', ParameterValue: AD_SECRET_ARN }]);
  return expected;
}

function loggedLines(): string[] {
  return (console.log as jest.Mock).mock.calls.concat((console.warn as jest.Mock).mock.calls)
    .map(args => args.map((a: unknown) => (typeof a === 'string' ? a : JSON.stringify(a))).join(' '));
}

const WINDOWS_EVENTS = {
  multiAzSsd: {
    storageId: 'stor-win-0001', name: 'Win Share', type: 'fsx-windows',
    configuration: { ssdStorageCapacity: 32, throughputCapacity: 32, automaticBackupRetentionPeriod: 7, resilience: 'multi-az', storageType: 'SSD' },
  },
  singleAzHdd: {
    storageId: 'stor-win-0002', name: 'Win Archive', type: 'fsx-windows',
    configuration: { ssdStorageCapacity: 2000, throughputCapacity: 64, automaticBackupRetentionPeriod: 0, resilience: 'single-az', storageType: 'HDD' },
  },
};

const SOURCE_REF = '{{resolve:secretsmanager:${OntapAdminPasswordSource}:SecretString:password}}';
const ONTAP_EVENT = {
  storageId: 'stor-0001',
  name: 'Media Share',
  type: 'fsx-ontap',
  configuration: { haPairs: 1, throughputCapacityPerHaPair: 128, deploymentType: 'SINGLE_AZ_2', storageCapacity: 1024 },
};

// A password in the style MRM generated before: 24 characters with a lowercase
// letter, an uppercase letter, a digit and one of !@#$%^&*.
function looksLikePassword(value: string): boolean {
  return /^[A-Za-z0-9!@#$%^&*]{24}$/.test(value)
    && /[a-z]/.test(value) && /[A-Z]/.test(value) && /[0-9]/.test(value) && /[!@#$%^&*]/.test(value);
}

function allOntapStrings(value: unknown, out: string[] = []): string[] {
  if (typeof value === 'string') out.push(value);
  else if (Array.isArray(value)) value.forEach(item => allOntapStrings(item, out));
  else if (value && typeof value === 'object') Object.values(value).forEach(item => allOntapStrings(item, out));
  return out;
}

async function generateOntapTemplate() {
  const result = await handler(ONTAP_EVENT);
  return { result, template: JSON.parse(result.template) };
}

describe('generate-fsx-template ONTAP credentials', () => {
  const env = { ...process.env };
  beforeEach(() => {
    process.env.PRODUCT_NAME = 'MediaResourceManager';
    process.env.ACRONYM = 'MRM';
    mockHasAdSecretArnParameter = true;
    GetSecretValueCommand.mockClear();
    jest.spyOn(console, 'log').mockImplementation(() => undefined);
    jest.spyOn(console, 'warn').mockImplementation(() => undefined);
  });
  afterEach(() => {
    process.env = { ...env };
    jest.restoreAllMocks();
  });

  it('has no AdminPassword parameter and returns none', async () => {
    const { result, template } = await generateOntapTemplate();
    expect(Object.keys(template.Parameters)).not.toContain('AdminPassword');
    expect(result.parameters.map((p: { ParameterKey: string }) => p.ParameterKey)).not.toContain('AdminPassword');
  });

  it('puts no password in the template or the return value', async () => {
    for (let run = 0; run < 20; run++) {
      const { result, template } = await generateOntapTemplate();
      const leaked = [...allOntapStrings(template), ...allOntapStrings(result.parameters)].filter(looksLikePassword);
      expect(leaked).toEqual([]);
    }
  });

  it('has Secrets Manager generate the password inside the stack', async () => {
    const { template } = await generateOntapTemplate();
    const source = template.Resources.OntapAdminPasswordSource;
    expect(source.Type).toBe('AWS::SecretsManager::Secret');
    expect(source.Properties.SecretString).toBeUndefined();
    const settings = source.Properties.GenerateSecretString;
    expect(settings).toMatchObject({ GenerateStringKey: 'password', IncludeSpace: false, RequireEachIncludedType: true });
    expect(settings.PasswordLength).toBeGreaterThanOrEqual(8);
    expect(settings.PasswordLength).toBeLessThanOrEqual(50);
    // JSON and dynamic-reference syntax must never appear in the password.
    for (const c of ['"', '\\', '{', '}']) expect(settings.ExcludeCharacters).toContain(c);
    // The punctuation MRM has always used stays available.
    for (const c of '!@#$%^&*') expect(settings.ExcludeCharacters).not.toContain(c);
  });

  it('keeps the credentials secret keys, with both admin passwords from the generated value', async () => {
    const { template } = await generateOntapTemplate();
    const secret = template.Resources.OntapAdminSecret.Properties;
    expect(secret.Name).toEqual({ 'Fn::Sub': '/${ProductName}/Storage/${StorageId}/OntapAdminCredentials' });
    const body = JSON.parse(secret.SecretString['Fn::Sub']);
    expect(Object.keys(body).sort()).toEqual(['fsxadminPassword', 'svmUsername', 'username', 'vsadminPassword']);
    expect(body).toEqual({ fsxadminPassword: SOURCE_REF, vsadminPassword: SOURCE_REF, username: 'fsxadmin', svmUsername: 'vsadmin' });
  });

  it('reads the file system and SVM admin passwords from the credentials secret', async () => {
    const { template } = await generateOntapTemplate();
    expect(template.Resources.FsxOntapFileSystem.Properties.OntapConfiguration.FsxAdminPassword).toEqual({
      'Fn::Sub': '{{resolve:secretsmanager:${OntapAdminSecret}:SecretString:fsxadminPassword}}',
    });
    expect(template.Resources.FsxOntapSvm.Properties.SvmAdminPassword).toEqual({
      'Fn::Sub': '{{resolve:secretsmanager:${OntapAdminSecret}:SecretString:vsadminPassword}}',
    });
  });

  it('changes only the AD credentials in the FSx for Windows output', async () => {
    for (const [key, event] of Object.entries(WINDOWS_EVENTS)) {
      const result = await handler(event);
      expect({ key, template: JSON.parse(result.template), parameters: result.parameters })
        .toEqual({ key, ...withAdSecretReference(WINDOWS_FIXTURE[key]) });
    }
  });

  it('puts no AD username or password in the FSx for Windows template or return value', async () => {
    for (const event of Object.values(WINDOWS_EVENTS)) {
      const result = await handler(event);
      const output = JSON.stringify(result);
      expect(output).not.toContain(FAKE_AD_PASSWORD);
      expect(output).not.toContain(FAKE_AD_USERNAME);
      const template = JSON.parse(result.template);
      const parameterKeys = result.parameters.map((p: StackParameter) => p.ParameterKey);
      for (const key of ['ADUsername', 'ADPassword']) {
        expect(Object.keys(template.Parameters)).not.toContain(key);
        expect(parameterKeys).not.toContain(key);
      }
    }
  });

  it('reads the AD username and password through dynamic references to the AD secret', async () => {
    const result = await handler(WINDOWS_EVENTS.multiAzSsd);
    const template = JSON.parse(result.template);
    const ad = template.Resources.FsxFileSystem.Properties.WindowsConfiguration.SelfManagedActiveDirectoryConfiguration;
    expect(ad.UserName).toEqual(AD_USERNAME_REF);
    expect(ad.Password).toEqual(AD_PASSWORD_REF);
    expect(template.Parameters.ADSecretId.Default).toBe(AD_SECRET_ARN);
    expect(template.Parameters.ADSecretId.NoEcho).toBeUndefined();
    expect(result.parameters).toContainEqual({ ParameterKey: 'ADSecretId', ParameterValue: AD_SECRET_ARN });
  });

  it('uses the legacy AD secret name when the AdServiceAccountSecretArn parameter is missing', async () => {
    mockHasAdSecretArnParameter = false;
    const result = await handler(WINDOWS_EVENTS.singleAzHdd);
    expect(JSON.parse(result.template).Parameters.ADSecretId.Default).toBe(LEGACY_AD_SECRET_NAME);
    expect(result.parameters).toContainEqual({ ParameterKey: 'ADSecretId', ParameterValue: LEGACY_AD_SECRET_NAME });
  });

  it('never reads the AD secret value', async () => {
    for (const event of Object.values(WINDOWS_EVENTS)) await handler(event);
    mockHasAdSecretArnParameter = false;
    await handler(WINDOWS_EVENTS.multiAzSsd);
    expect(GetSecretValueCommand).not.toHaveBeenCalled();
  });

  it('never logs the AD password on the FSx for Windows path', async () => {
    for (const event of Object.values(WINDOWS_EVENTS)) await handler(event);
    const logged = loggedLines();
    expect(logged.length).toBeGreaterThan(0);
    expect(logged.filter(line => line.includes(FAKE_AD_PASSWORD))).toEqual([]);
  });

  it('redacts credentials in the event before logging it', async () => {
    const canary = 'canary-credential-value';
    await handler({ ...ONTAP_EVENT, taskToken: canary, configuration: { ...ONTAP_EVENT.configuration, adminPassword: canary } });
    const logged = (console.log as jest.Mock).mock.calls.map(args => args.map((a: unknown) => (typeof a === 'string' ? a : JSON.stringify(a))).join(' '));
    expect(logged.some(line => line.includes('received event'))).toBe(true);
    expect(logged.filter(line => line.includes(canary))).toEqual([]);
  });
});
