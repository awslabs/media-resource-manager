// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0
/**
 * ResourceAdmin password age (AdMode=managed). AWS Managed Microsoft AD
 * expires passwords after the directory's maximum password age, so MRM sets
 * ResourceAdmin's password to its stored value when the custom resource's
 * Version changes (custom resource
 * Update) and every 30 days (EventBridge schedule).
 */
import { spawnSync } from 'child_process';
import * as path from 'path';
import * as cdk from 'aws-cdk-lib';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as kms from 'aws-cdk-lib/aws-kms';
import { Match, Template } from 'aws-cdk-lib/assertions';
import { IdentityConstruct } from '../lib/constructs/identity-construct';

type Statement = { Effect: string; Action: string | string[]; Resource: unknown; Condition?: unknown };

function synth(adMode: 'managed' | 'connector'): Template {
  const app = new cdk.App();
  const stack = new cdk.Stack(app, 'Identity', { env: { account: '123456789012', region: 'us-east-1' } });
  const vpc = new ec2.Vpc(stack, 'Vpc', { maxAzs: 2 });
  new IdentityConstruct(stack, 'Identity', {
    vpc,
    privateSubnets: vpc.privateSubnets,
    pascalCaseName: 'MediaResourceManager',
    acronym: 'MRM',
    userTableName: 'mrm-users',
    encryptionKey: new kms.Key(stack, 'DataKey'),
    adMode,
    adConnectorConfig: adMode === 'connector'
      ? {
        domainName: 'example.internal',
        dnsServerIps: ['10.0.0.10', '10.0.1.10'],
        serviceAccountSecretArn: 'arn:aws:secretsmanager:us-east-1:123456789012:secret:svc-abc123', // pragma: allowlist secret
      }
      : undefined,
  });
  return Template.fromStack(stack);
}

const REFRESH_FUNCTION = 'mrm-resourceadmin-password-refresh';

function logicalIdOf(template: Template, type: string, props: Record<string, unknown>): string {
  const ids = Object.keys(template.findResources(type, { Properties: props }));
  expect(ids).toHaveLength(1);
  return ids[0];
}

function statementsFor(template: Template, functionName: string): Statement[] {
  const fn = Object.values(template.findResources('AWS::Lambda::Function', {
    Properties: { FunctionName: functionName },
  }))[0] as { Properties: { Role: { 'Fn::GetAtt': [string, string] } } };
  const roleId = fn.Properties.Role['Fn::GetAtt'][0];
  return Object.values(template.findResources('AWS::IAM::Policy'))
    .filter((p: any) => p.Properties.Roles.some((r: { Ref: string }) => r.Ref === roleId))
    .flatMap((p: any) => p.Properties.PolicyDocument.Statement as Statement[]);
}

describe('ResourceAdmin password age, AdMode=managed', () => {
  const template = synth('managed');

  it('re-runs the ResourceAdmin custom resource on the next deploy', () => {
    const users = template.findResources('AWS::CloudFormation::CustomResource', {
      Properties: { Username: 'ResourceAdmin' },
    });
    expect(Object.values(users).map((r: any) => r.Properties.Version)).toEqual(['11']);
  });

  it('resets the password on a 30-day schedule', () => {
    const fnId = logicalIdOf(template, 'AWS::Lambda::Function', {
      FunctionName: REFRESH_FUNCTION,
      Handler: 'index.scheduled_reset_handler',
      Environment: { Variables: Match.objectLike({ USERNAME: 'ResourceAdmin' }) },
    });
    template.hasResourceProperties('AWS::Events::Rule', {
      ScheduleExpression: 'rate(30 days)',
      State: 'ENABLED',
      Targets: [Match.objectLike({ Arn: { 'Fn::GetAtt': [fnId, 'Arn'] } })],
    });
  });

  it('gives the scheduled function only the reset, the ResourceAdmin secret and its key', () => {
    const statements = statementsFor(template, REFRESH_FUNCTION);
    const byAction = (action: string) => statements.filter((s) => ([] as string[]).concat(s.Action).includes(action));

    const resourceAdminSecretId = logicalIdOf(template, 'AWS::SecretsManager::Secret', {
      Name: '/MediaResourceManager/Identity/ResourceAdminActiveDirectoryLoginCredentials',
    });
    const directoryId = logicalIdOf(template, 'AWS::DirectoryService::MicrosoftAD', {});

    const reset = byAction('ds:ResetUserPassword');
    expect(reset).toHaveLength(1);
    expect(reset[0].Action).toEqual('ds:ResetUserPassword');
    expect(JSON.stringify(reset[0].Resource)).toContain(`{"Ref":"${directoryId}"}`);
    expect(JSON.stringify(reset[0].Resource)).not.toContain('*');

    const read = byAction('secretsmanager:GetSecretValue');
    expect(read).toHaveLength(1);
    expect(read[0].Resource).toEqual({ Ref: resourceAdminSecretId });

    const decrypt = byAction('kms:Decrypt');
    expect(decrypt).toHaveLength(1);
    expect(decrypt[0].Resource).toEqual({ 'Fn::GetAtt': [expect.stringMatching(/^DataKey/), 'Arn'] });

    const allActions = statements.flatMap((s) => ([] as string[]).concat(s.Action));
    expect(new Set(allActions)).toEqual(new Set(['ds:ResetUserPassword', 'secretsmanager:GetSecretValue', 'kms:Decrypt']));
  });

  it('runs outside the VPC', () => {
    const fns = template.findResources('AWS::Lambda::Function', { Properties: { FunctionName: REFRESH_FUNCTION } });
    expect(Object.values(fns).map((f: any) => f.Properties.VpcConfig)).toEqual([undefined]);
  });

  it('alarms when a scheduled reset fails', () => {
    const fnId = logicalIdOf(template, 'AWS::Lambda::Function', { FunctionName: REFRESH_FUNCTION });
    template.hasResourceProperties('AWS::CloudWatch::Alarm', {
      MetricName: 'Errors',
      Namespace: 'AWS/Lambda',
      Dimensions: [{ Name: 'FunctionName', Value: { Ref: fnId } }],
      Threshold: 1,
      ComparisonOperator: 'GreaterThanOrEqualToThreshold',
    });
  });
});

describe('ResourceAdmin password age, AdMode=connector', () => {
  const template = synth('connector');

  it('creates no schedule, reset function or alarm', () => {
    expect(template.findResources('AWS::Lambda::Function', { Properties: { FunctionName: REFRESH_FUNCTION } })).toEqual({});
    expect(template.findResources('AWS::Events::Rule')).toEqual({});
    expect(template.findResources('AWS::CloudWatch::Alarm')).toEqual({});
  });
});

describe('ad-user-manager Lambda', () => {
  it('passes its Python unit tests', () => {
    const result = spawnSync('python3', ['-m', 'unittest', path.join(__dirname, 'python', 'test_ad_user_manager.py')], {
      encoding: 'utf8',
    });
    if (result.status !== 0) {
      throw new Error(`${result.stdout}\n${result.stderr}`);
    }
    expect(result.stderr).toMatch(/OK/);
  });
});
