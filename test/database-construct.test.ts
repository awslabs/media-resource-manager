// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import * as cdk from 'aws-cdk-lib';
import { Template } from 'aws-cdk-lib/assertions';
import { DatabaseConstruct } from '../lib/constructs/database-construct';

/**
 * Hermetic unit tests for DatabaseConstruct. These synthesize the construct
 * into a CloudFormation template and assert on the generated DynamoDB tables.
 * No AWS credentials, context, or environment lookups are required.
 */
function synth(acronym: string): Template {
  const app = new cdk.App();
  const stack = new cdk.Stack(app, 'TestStack');
  new DatabaseConstruct(stack, 'Database', {
    pascalCaseName: 'MediaResourceManager',
    acronym,
  });
  return Template.fromStack(stack);
}

describe('DatabaseConstruct', () => {
  it('names its core tables using the lowercase acronym prefix', () => {
    const template = synth('MRM');
    for (const tableName of [
      'mrm-users',
      'mrm-workstations',
      'mrm-amis',
      'mrm-hostname-counters',
    ]) {
      template.hasResourceProperties('AWS::DynamoDB::Table', {
        TableName: tableName,
      });
    }
  });

  it('derives the table prefix from the acronym case-insensitively', () => {
    const template = synth('CE');
    template.hasResourceProperties('AWS::DynamoDB::Table', {
      TableName: 'ce-users',
    });
  });

  it('provisions every table with on-demand (PAY_PER_REQUEST) billing', () => {
    const template = synth('MRM');
    const tables = template.findResources('AWS::DynamoDB::Table');
    const logicalIds = Object.keys(tables);

    expect(logicalIds.length).toBeGreaterThanOrEqual(8);
    for (const id of logicalIds) {
      expect(tables[id].Properties.BillingMode).toBe('PAY_PER_REQUEST');
    }
  });

  it('enables point-in-time recovery on the users table', () => {
    const template = synth('MRM');
    template.hasResourceProperties('AWS::DynamoDB::Table', {
      TableName: 'mrm-users',
      PointInTimeRecoverySpecification: {
        PointInTimeRecoveryEnabled: true,
      },
    });
  });
});
