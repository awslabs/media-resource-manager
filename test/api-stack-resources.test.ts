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
    env, ...names, storageTable, workstationTable, regionalHubsTable, dataEncryptionKey, adServiceAccountSecretArn,
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
