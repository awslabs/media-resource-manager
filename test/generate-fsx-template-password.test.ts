// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0
/**
 * Unit tests for how the FSx for ONTAP template (lambda/generate-fsx-template)
 * handles the ONTAP admin credentials: the stack generates them in Secrets
 * Manager, and neither the template nor the Lambda's return value (which
 * Step Functions records) carries a password.
 */
// Fixed fake AD service-account credentials for the FSx for Windows path
// (getAdCredentials reads them from SSM + Secrets Manager).
const FAKE_AD_PASSWORD = 'not-a-real-ad-value-0000';

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
      if (command.input.Name.endsWith('/Identity/AdServiceAccountSecretArn')) {
        return { Parameter: { Value: 'arn:aws:secretsmanager:us-east-1:123456789012:secret:unit-test-ad' } };
      }
      throw Object.assign(new Error(`unexpected parameter ${command.input.Name}`), { name: 'ParameterNotFound' });
    }),
  })),
  GetParameterCommand: jest.fn((input: unknown) => ({ input })),
}), { virtual: true });

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { handler } = require('../lambda/generate-fsx-template/index.js');
// Output of origin/main's handler (before this change) for WINDOWS_EVENTS,
// captured with the same mocks. The Windows path must not change.
// eslint-disable-next-line @typescript-eslint/no-var-requires
const WINDOWS_FIXTURE = require('./fixtures/generate-fsx-template-windows.json');

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
    jest.spyOn(console, 'log').mockImplementation(() => undefined);
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

  it('leaves the FSx for Windows output unchanged', async () => {
    for (const [key, event] of Object.entries(WINDOWS_EVENTS)) {
      const result = await handler(event);
      expect({ key, template: JSON.parse(result.template), parameters: result.parameters })
        .toEqual({ key, ...WINDOWS_FIXTURE[key] });
    }
  });

  it('never logs the AD password on the FSx for Windows path', async () => {
    for (const event of Object.values(WINDOWS_EVENTS)) await handler(event);
    const logged = (console.log as jest.Mock).mock.calls.map(args => args.map((a: unknown) => (typeof a === 'string' ? a : JSON.stringify(a))).join(' '));
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
