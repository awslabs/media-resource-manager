// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import * as cdk from 'aws-cdk-lib';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as kms from 'aws-cdk-lib/aws-kms';
import * as logs from 'aws-cdk-lib/aws-logs';
import { Construct } from 'constructs';
import { LambdaLogRetentionConstruct } from './constructs/lambda-log-retention-construct';

export interface LogRetentionStackProps extends cdk.StackProps {
  pascalCaseName: string;
  acronym: string;
  retentionDays: logs.RetentionDays;
  regionalHubsTable: dynamodb.ITable;
  dataEncryptionKey?: kms.IKey;
}

/**
 * Sets a retention period on every Lambda log group in the deployment. The
 * app makes this stack depend on every other stack, so it deploys last, when
 * all functions exist.
 */
export class LogRetentionStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props: LogRetentionStackProps) {
    super(scope, id, {
      ...props,
      description: 'Sets a retention period on the Lambda log groups of every stack and regional hub',
    });

    new LambdaLogRetentionConstruct(this, 'LambdaLogRetention', {
      pascalCaseName: props.pascalCaseName,
      acronym: props.acronym,
      retentionDays: props.retentionDays,
      regionalHubsTable: props.regionalHubsTable,
      dataEncryptionKey: props.dataEncryptionKey,
    });
  }
}
