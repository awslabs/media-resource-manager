// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * The DCV session manager role may read the browser gateway URL. Without the
 * grant, the Lambda falls back to the direct gateway URL without failing, so
 * this is checked on the synthesized template.
 */
import * as cdk from 'aws-cdk-lib';
import { Template } from 'aws-cdk-lib/assertions';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as sfn from 'aws-cdk-lib/aws-stepfunctions';
import { ApiStack } from '../lib/api-stack';
import { StorageStack } from '../lib/storage-stack';

const env = { account: '123456789012', region: 'us-east-1' };

function buildTemplate(): Template {
  const app = new cdk.App();
  const deps = new cdk.Stack(app, 'Deps', { env });
  const table = (id: string) =>
    new dynamodb.Table(deps, id, { partitionKey: { name: 'id', type: dynamodb.AttributeType.STRING } });
  const stateMachine = (id: string) =>
    new sfn.StateMachine(deps, id, { definitionBody: sfn.DefinitionBody.fromChainable(new sfn.Pass(deps, `${id}Pass`)) });
  const fn = (id: string) =>
    new lambda.Function(deps, id, { runtime: lambda.Runtime.NODEJS_22_X, handler: 'index.handler', code: lambda.Code.fromInline('exports.handler=async()=>({})') });

  // ApiStack only wires the storage functions into API Gateway integrations.
  const storageFunctions: Record<string, lambda.Function> = {};
  const storageStack = {
    functions: new Proxy(storageFunctions, {
      get: (target, key: string) => (target[key] ??= fn(`Storage${key}`)),
    }),
  } as unknown as StorageStack;

  const api = new ApiStack(app, 'MRM-Api', {
    env,
    productName: 'Media Resource Manager',
    pascalCaseName: 'MediaResourceManager',
    acronym: 'MRM',
    useCognitoAuth: true,
    userTable: table('Users'),
    workstationTable: table('Workstations'),
    amiTable: table('Amis'),
    groupsTable: table('Groups'),
    storageTable: table('Storage'),
    regionalHubsTable: table('RegionalHubs'),
    imagePipelinesTable: table('ImagePipelines'),
    softwareLibraryTable: table('SoftwareLibrary'),
    windowsWorkstationCreationStateMachine: stateMachine('WindowsCreate'),
    linuxWorkstationCreationStateMachine: stateMachine('LinuxCreate'),
    workstationStartStateMachine: 'arn:aws:states:us-east-1:123456789012:stateMachine:start',
    vpc: new ec2.Vpc(deps, 'Vpc', { maxAzs: 2, natGateways: 1 }),
    storageStack,
    imageBuilderInstanceProfile: 'profile',
    imageBuilderLogsBucket: 'logs-bucket',
    imageBuilderServiceRoleArn: 'arn:aws:iam::123456789012:role/image-builder',
    imageBuilderUploadsBucket: 'uploads-bucket',
    buildSubnetId: 'subnet-00000000',
    buildSecurityGroupId: 'sg-00000000',
    enableBedrockFeatures: false,
    adServiceAccountSecretArn: 'arn:aws:secretsmanager:us-east-1:123456789012:secret:ad-AbCdEf',
  } as any);
  return Template.fromStack(api);
}

describe('ApiStack DCV session manager SSM access', () => {
  let template: Template;
  beforeAll(() => {
    template = buildTemplate();
  });

  function sessionManagerSsmResources(): string[] {
    const fns = template.findResources('AWS::Lambda::Function', {
      Properties: { FunctionName: 'mrm-dcv-session-manager' },
    });
    expect(Object.keys(fns)).toHaveLength(1);
    const roleId = Object.values(fns)[0].Properties.Role['Fn::GetAtt'][0];
    const statements = Object.values(template.findResources('AWS::IAM::Policy'))
      .filter((p: any) => p.Properties.Roles.some((r: any) => r.Ref === roleId))
      .flatMap((p: any) => p.Properties.PolicyDocument.Statement);
    const ssm = statements.filter((st: any) => ([] as unknown[]).concat(st.Action).includes('ssm:GetParameter'));
    return ssm.flatMap((st: any) => ([] as unknown[]).concat(st.Resource)).map((r: unknown) => JSON.stringify(r));
  }

  it('can read /<ProductName>/DCV/BrowserGatewayUrl, and only that parameter outside its existing paths', () => {
    const resources = sessionManagerSsmResources();
    expect(resources.some((r) => r.includes(':parameter/MediaResourceManager/DCV/BrowserGatewayUrl"'))).toBe(true);
    for (const r of resources) {
      expect(r).toMatch(/:parameter\/MediaResourceManager\/DCV\/(SessionManager\/\*|ConnectionGateway\/\*|BrowserGatewayUrl)"/);
    }
  });
});
