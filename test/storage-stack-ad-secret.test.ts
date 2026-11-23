// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0
/**
 * IAM for the FSx for Windows AD secret in StorageStack. The storage stack's
 * template reads the AD service-account secret through dynamic references,
 * which CloudFormation resolves with storage-cfn-worker's credentials. The
 * template generator only needs the secret's ARN.
 */
import * as cdk from 'aws-cdk-lib';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as kms from 'aws-cdk-lib/aws-kms';
import { Template } from 'aws-cdk-lib/assertions';
import { StorageStack } from '../lib/storage-stack';

type Statement = { Action: string | string[]; Resource?: unknown; Condition?: Record<string, Record<string, unknown>> };

function synthStorageStack(): Template {
  const app = new cdk.App();
  const env = { account: '123456789012', region: 'us-east-1' };
  const base = new cdk.Stack(app, 'Base', { env });
  const key = new kms.Key(base, 'DataKey');
  const table = (id: string) => new dynamodb.Table(base, id, {
    partitionKey: { name: 'id', type: dynamodb.AttributeType.STRING },
    encryption: dynamodb.TableEncryption.CUSTOMER_MANAGED,
    encryptionKey: key,
  });
  const stack = new StorageStack(app, 'Storage', {
    env,
    storageTable: table('Storage'),
    workstationTable: table('Workstations'),
    regionalHubsTable: table('RegionalHubs'),
    pascalCaseName: 'MediaResourceManager',
    acronym: 'MRM',
    dataEncryptionKey: key,
  });
  return Template.fromStack(stack);
}

// Every statement in the inline policies of the role used by the function
// with this FunctionName.
function statementsFor(template: Template, functionName: string): Statement[] {
  const fn = Object.values(template.findResources('AWS::Lambda::Function', {
    Properties: { FunctionName: functionName },
  }))[0] as { Properties: { Role: { 'Fn::GetAtt': [string, string] } } };
  const roleId = fn.Properties.Role['Fn::GetAtt'][0];
  return Object.values(template.findResources('AWS::IAM::Policy'))
    .filter((p: any) => p.Properties.Roles.some((r: { Ref: string }) => r.Ref === roleId))
    .flatMap((p: any) => p.Properties.PolicyDocument.Statement as Statement[]);
}

const actionsOf = (s: Statement) => ([] as string[]).concat(s.Action);

describe('StorageStack AD secret access', () => {
  const template = synthStorageStack();

  it('gives the template generator no access to secret values', () => {
    const actions = statementsFor(template, 'mrm-generate-fsx-template').flatMap(actionsOf);
    expect(actions).not.toContain('secretsmanager:GetSecretValue');
    expect(actions).toContain('ssm:GetParameter');
  });

  it('lets storage-cfn-worker read secrets and decrypt the data key only through Secrets Manager', () => {
    const statements = statementsFor(template, 'mrm-storage-cfn-worker');
    expect(statements.flatMap(actionsOf)).toContain('secretsmanager:GetSecretValue');
    const decrypt = statements.filter(s => actionsOf(s).includes('kms:Decrypt'));
    expect(decrypt).toHaveLength(1);
    expect(decrypt[0].Condition).toEqual({
      StringEquals: { 'kms:ViaService': 'secretsmanager.us-east-1.amazonaws.com' },
    });
  });
});
