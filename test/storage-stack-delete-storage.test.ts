// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0
/**
 * The delete-storage Lambda gets the acronym, so it can tell an MRM storage
 * stack (<Acronym>-Storage-*) from another stack name (#143), and its
 * CloudFormation access stays limited to MRM storage stacks.
 */
import * as cdk from 'aws-cdk-lib';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as kms from 'aws-cdk-lib/aws-kms';
import { Template } from 'aws-cdk-lib/assertions';
import { StorageStack } from '../lib/storage-stack';

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

describe('StorageStack delete-storage function', () => {
  const template = synthStorageStack();
  const fn = Object.entries(template.findResources('AWS::Lambda::Function', {
    Properties: { FunctionName: 'mrm-delete-storage' },
  }))[0] as [string, any];

  it('passes the acronym to delete-storage', () => {
    expect(fn).toBeDefined();
    expect(fn[1].Properties.Environment.Variables.ACRONYM).toBe('MRM');
  });

  it('keeps its CloudFormation access to MRM storage stacks', () => {
    const roleId = fn[1].Properties.Role['Fn::GetAtt'][0];
    const statements = Object.values(template.findResources('AWS::IAM::Policy'))
      .filter((p: any) => p.Properties.Roles.some((r: { Ref: string }) => r.Ref === roleId))
      .flatMap((p: any) => p.Properties.PolicyDocument.Statement as any[]);
    const cfn = statements.filter(s => ([] as string[]).concat(s.Action).some(a => a.startsWith('cloudformation:')));
    expect(cfn).toHaveLength(1);
    expect(JSON.stringify(cfn[0].Resource)).toContain(':stack/MRM-Storage-*');
  });
});
