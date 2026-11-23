// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import * as cdk from 'aws-cdk-lib';
import { Template } from 'aws-cdk-lib/assertions';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as kms from 'aws-cdk-lib/aws-kms';
import * as secretsmanager from 'aws-cdk-lib/aws-secretsmanager';
import * as stepfunctions from 'aws-cdk-lib/aws-stepfunctions';
import { ApiStack } from '../lib/api-stack';
import { DataSyncStack } from '../lib/datasync-stack';
import { StorageStack } from '../lib/storage-stack';

/**
 * Hermetic synth of the API stack with stub dependencies. CloudFormation
 * allows 500 resources per stack, and the API stack used to sit at 497
 * because every method added two Lambda invoke permissions (#59).
 */
function synth(): Template {
  const app = new cdk.App();
  const env = { account: '123456789012', region: 'us-east-1' };
  const deps = new cdk.Stack(app, 'Deps', { env });
  const table = (id: string) => new dynamodb.Table(deps, id, {
    partitionKey: { name: 'id', type: dynamodb.AttributeType.STRING },
  });
  const stateMachine = (id: string) => new stepfunctions.StateMachine(deps, id, {
    definitionBody: stepfunctions.DefinitionBody.fromChainable(new stepfunctions.Pass(deps, `${id}Pass`)),
  });
  const vpc = new ec2.Vpc(deps, 'Vpc', { maxAzs: 2 });
  const dataEncryptionKey = new kms.Key(deps, 'Key');
  const names = { pascalCaseName: 'MediaResourceManager', acronym: 'MRM' };
  const adServiceAccountSecretArn = new secretsmanager.Secret(deps, 'AdServiceAccount').secretArn;
  const storageTable = table('Storage');
  const workstationTable = table('Workstations');
  const regionalHubsTable = table('RegionalHubs');

  const storageStack = new StorageStack(app, 'Storage', {
    env, ...names, storageTable, workstationTable, regionalHubsTable, dataEncryptionKey,
  });
  const dataSyncStack = new DataSyncStack(app, 'DataSync', {
    env, ...names, storageTable, dataEncryptionKey, adServiceAccountSecretArn,
  });
  const stack = new ApiStack(app, 'Api', {
    env,
    ...names,
    productName: 'Media Resource Manager',
    userTable: table('Users'),
    workstationTable,
    amiTable: table('Amis'),
    groupsTable: table('Groups'),
    storageTable,
    regionalHubsTable,
    imagePipelinesTable: table('Pipelines'),
    softwareLibraryTable: table('SoftwareLibrary'),
    instanceTypeCatalogTable: table('InstanceTypes'),
    windowsWorkstationCreationStateMachine: stateMachine('Windows'),
    linuxWorkstationCreationStateMachine: stateMachine('Linux'),
    workstationStartStateMachine: 'arn:aws:states:us-east-1:123456789012:stateMachine:start',
    vpc,
    storageStack,
    dataSyncStack,
    imageBuilderInstanceProfile: 'profile',
    imageBuilderLogsBucket: 'logs-bucket',
    imageBuilderServiceRoleArn: 'arn:aws:iam::123456789012:role/image-builder',
    imageBuilderUploadsBucket: 'uploads-bucket',
    buildSubnetId: 'subnet-12345678',
    buildSecurityGroupId: 'sg-12345678',
    dataEncryptionKey,
    agentExecutionStateTable: table('AgentExecution'),
    agentUsageTable: table('AgentUsage'),
    agentProgressTable: table('AgentProgress'),
    scriptGenerationStateMachine: stateMachine('ScriptGeneration'),
    enableBedrockFeatures: true,
    adServiceAccountSecretArn,
  });
  return Template.fromStack(stack);
}

/** Flatten a CloudFormation value (strings, Fn::Join, Fn::GetAtt, ...) to one string. */
function flat(value: unknown): string {
  return JSON.stringify(value);
}

describe('API stack resource count (#59)', () => {
  let template: Template;
  beforeAll(() => {
    template = synth();
  }, 120000);

  test('stays well under the CloudFormation limit of 500 resources', () => {
    const count = Object.keys(template.toJSON().Resources).length;
    expect(count).toBeLessThan(400);
  });

  test('each integrated function has one API-wide invoke permission', () => {
    const resources = template.toJSON().Resources as Record<string, any>;
    const permissions = Object.values(resources).filter(r =>
      r.Type === 'AWS::Lambda::Permission' &&
      r.Properties.Principal === 'apigateway.amazonaws.com' &&
      !flat(r.Properties.SourceArn).includes('/authorizers/'));

    // Functions behind API methods, taken from each method's integration URI.
    const integrated = new Set(Object.values(resources)
      .filter(r => r.Type === 'AWS::ApiGateway::Method' && r.Properties.Integration?.Type === 'AWS_PROXY')
      .map(r => {
        // [..., ':apigateway:<region>:lambda:path/2015-03-31/functions/', <function ARN>, '/invocations']
        const parts: unknown[] = r.Properties.Integration.Uri['Fn::Join'][1];
        const i = parts.findIndex(p => typeof p === 'string' && p.endsWith('/functions/'));
        return flat(parts[i + 1]);
      }));
    expect(integrated.size).toBeGreaterThan(30);

    const permitted = permissions.map(p => flat(p.Properties.FunctionName));
    expect(new Set(permitted).size).toBe(permitted.length);
    expect(new Set(permitted)).toEqual(integrated);

    // The source ARN covers every stage, method and path of this API only.
    for (const p of permissions) {
      const parts = p.Properties.SourceArn['Fn::Join'][1];
      expect(parts[parts.length - 1]).toBe('/*/*/*');
      expect(flat(parts)).toContain('"Ref":"');
    }
  });
});

describe('FSx SMB mount manager permissions', () => {
  let statements: any[];
  let environment: Record<string, unknown>;
  beforeAll(() => {
    const template = synth();
    const resources = template.toJSON().Resources as Record<string, any>;
    const [fnId, fn] = Object.entries(resources).find(([id, r]) =>
      r.Type === 'AWS::Lambda::Function' && id.startsWith('FsxMountManagerFunction'))!;
    environment = fn.Properties.Environment.Variables;
    const roleRef = JSON.stringify(fn.Properties.Role['Fn::GetAtt'][0]);
    statements = Object.values(resources)
      .filter(r => r.Type === 'AWS::IAM::Policy' && JSON.stringify(r.Properties.Roles).includes(roleRef))
      .flatMap(r => r.Properties.PolicyDocument.Statement);
    expect(fnId).toBeDefined();
  }, 120000);

  test('can write, but not read, the per-workstation SMB mount secrets', () => {
    const smb = statements.filter(s => JSON.stringify(s.Resource).includes('SmbMount'));
    expect(smb).toHaveLength(1);
    expect([...smb[0].Action].sort()).toEqual([
      'secretsmanager:CreateSecret',
      'secretsmanager:DeleteSecret',
      'secretsmanager:DescribeSecret',
      'secretsmanager:PutResourcePolicy',
      'secretsmanager:PutSecretValue',
    ]);
    expect(flat(smb[0].Resource)).toContain('/MediaResourceManager/Workstation/*/SmbMount');
    expect(flat(smb[0].Resource)).not.toContain('secret:*');
  });

  test('gets the acronym for the regional workstation role names', () => {
    expect(environment.ACRONYM).toBe('MRM');
  });
});

describe('API stack /auth routes', () => {
  let resources: Record<string, any>;
  beforeAll(() => {
    resources = synth().toJSON().Resources as Record<string, any>;
  }, 120000);

  const byType = (type: string) => Object.entries(resources).filter(([, r]) => r.Type === type);
  const authId = () => {
    const auth = byType('AWS::ApiGateway::Resource').find(([, r]) => r.Properties.PathPart === 'auth');
    expect(auth).toBeDefined();
    return auth![0];
  };
  const childrenOfAuth = () => byType('AWS::ApiGateway::Resource')
    .filter(([, r]) => flat(r.Properties.ParentId) === flat({ Ref: authId() }));

  test('/auth has only the ldap resource', () => {
    expect(childrenOfAuth().map(([, r]) => r.Properties.PathPart)).toEqual(['ldap']);
  });

  test('no validate-jwt function is deployed', () => {
    const names = byType('AWS::Lambda::Function').map(([, r]) => flat(r.Properties.FunctionName ?? ''));
    expect(names.some(n => n.includes('ldap-auth'))).toBe(true);
    expect(names.some(n => n.includes('validate-jwt'))).toBe(false);
  });

  test('POST /auth/ldap stays reachable before sign-in', () => {
    const [ldapId] = childrenOfAuth()[0];
    const methods = byType('AWS::ApiGateway::Method')
      .filter(([, r]) => flat(r.Properties.ResourceId) === flat({ Ref: ldapId }) && r.Properties.HttpMethod === 'POST');
    expect(methods).toHaveLength(1);
    expect(methods[0][1].Properties.AuthorizationType).toBe('NONE');
  });

  test('the stage throttles POST /auth/ldap', () => {
    const stages = byType('AWS::ApiGateway::Stage');
    expect(stages).toHaveLength(1);
    const settings = stages[0][1].Properties.MethodSettings as any[];
    expect(settings).toEqual(expect.arrayContaining([
      expect.objectContaining({
        ResourcePath: '/~1auth~1ldap',
        HttpMethod: 'POST',
        ThrottlingRateLimit: 10,
        ThrottlingBurstLimit: 20,
      }),
    ]));
  });
});
