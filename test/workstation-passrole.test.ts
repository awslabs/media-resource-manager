// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import * as cdk from 'aws-cdk-lib';
import { Template } from 'aws-cdk-lib/assertions';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as kms from 'aws-cdk-lib/aws-kms';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import { LinuxWorkstationCreationStack } from '../lib/workstation-creation-stack-linux';
import { MacOSWorkstationCreationStack } from '../lib/workstation-creation-stack-macos';
import { WindowsWorkstationCreationStack } from '../lib/workstation-creation-stack-windows';

/**
 * The workstation creation Lambdas launch workstations in regional hubs with
 * the hub's workstation role. Hubs name it with or without a Region suffix
 * (see buildIamName in lambda/generate-regional-hub-template), so both names
 * must be passable to EC2.
 */
const ACCOUNT = '123456789012';

function synthAll(): Record<string, Template> {
  const app = new cdk.App();
  const env = { account: ACCOUNT, region: 'us-east-1' };
  const deps = new cdk.Stack(app, 'Deps', { env });
  const table = (id: string) => new dynamodb.Table(deps, id, {
    partitionKey: { name: 'id', type: dynamodb.AttributeType.STRING },
  });
  const vpc = new ec2.Vpc(deps, 'Vpc', { maxAzs: 2 });
  const common = {
    env,
    productName: 'Media Resource Manager',
    pascalCaseName: 'MediaResourceManager',
    acronym: 'MRM',
    workstationTable: table('Workstations'),
    imagePipelinesTable: table('Pipelines'),
    amiTable: table('Amis'),
    hostnameCounterTable: table('Hostnames'),
    regionalHubsTable: table('Hubs'),
    vpc,
    workstationSecurityGroup: new ec2.SecurityGroup(deps, 'Sg', { vpc }),
    sessionCleanupFunction: new lambda.Function(deps, 'Cleanup', {
      runtime: lambda.Runtime.PYTHON_3_12,
      handler: 'index.handler',
      code: lambda.Code.fromInline('def handler(e, c): return e'),
    }),
    dataEncryptionKey: new kms.Key(deps, 'Key'),
  };
  const launchTemplate = (id: string) => new ec2.LaunchTemplate(deps, `Lt${id}`, {
    role: new iam.Role(deps, `Role${id}`, { assumedBy: new iam.ServicePrincipal('ec2.amazonaws.com') }),
  });
  // Build every stack before the first synth.
  const stacks = {
    windows: new WindowsWorkstationCreationStack(app, 'Windows', { ...common, workstationLaunchTemplate: launchTemplate('Windows') }),
    linux: new LinuxWorkstationCreationStack(app, 'Linux', { ...common, workstationLaunchTemplate: launchTemplate('Linux') }),
    macos: new MacOSWorkstationCreationStack(app, 'MacOS', common),
  };
  return Object.fromEntries(Object.entries(stacks).map(([k, s]) => [k, Template.fromStack(s)]));
}

const TEMPLATES = synthAll();

/** IAM statements attached to the role of the named function. */
function statementsFor(template: Template, functionName: string): any[] {
  const fns = template.findResources('AWS::Lambda::Function', { Properties: { FunctionName: functionName } });
  const roleId = Object.values(fns)[0].Properties.Role['Fn::GetAtt'][0];
  return Object.values(template.findResources('AWS::IAM::Policy'))
    .filter((p: any) => p.Properties.Roles.some((r: any) => r.Ref === roleId))
    .flatMap((p: any) => p.Properties.PolicyDocument.Statement);
}

const role = (name: string) => `arn:aws:iam::${ACCOUNT}:role/${name}`;

describe.each(['windows', 'linux', 'macos'])('%s workstation creation PassRole', (platform) => {
  const statements = statementsFor(TEMPLATES[platform], `mrm-instance-create-${platform}`);
  const regional = statements.filter((st: any) => st.Action === 'iam:PassRole'
    && [st.Resource].flat().some((r: any) => typeof r === 'string' && r.includes('-Regional-Workstation-Role')));

  it('can pass the workstation role of hubs with and without a Region suffix', () => {
    expect(regional).toHaveLength(1);
    expect(regional[0].Resource).toEqual([
      role('MediaResourceManager-Regional-Workstation-Role'),
      role('MediaResourceManager-Regional-Workstation-Role-*'),
      role('MRM-Regional-Workstation-Role-*'),
    ]);
  });

  it('only passes those roles to EC2', () => {
    expect(regional[0].Condition).toEqual({ StringEquals: { 'iam:PassedToService': 'ec2.amazonaws.com' } });
  });
});
