// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import * as crypto from 'crypto';
import * as path from 'path';
import * as cdk from 'aws-cdk-lib';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as events from 'aws-cdk-lib/aws-events';
import * as targets from 'aws-cdk-lib/aws-events-targets';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as kms from 'aws-cdk-lib/aws-kms';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as cr from 'aws-cdk-lib/custom-resources';
import { Construct } from 'constructs';

export interface LambdaLogRetentionConstructProps {
  pascalCaseName: string;
  acronym: string;
  /** Days to keep Lambda log events. Must be a value CloudWatch Logs accepts. */
  retentionDays: logs.RetentionDays;
  regionalHubsTable: dynamodb.ITable;
  dataEncryptionKey?: kms.IKey;
}

/**
 * Sets a retention period on every Lambda log group in this deployment.
 *
 * Lambda creates /aws/lambda/<function> on a function's first run, outside
 * CloudFormation, so CDK can't declare those log groups without failing on
 * "already exists". A custom resource sets the retention period instead. It
 * runs whenever the app's set of functions or these settings change, and when
 * a regional hub is created. Log groups that already have a retention period
 * are left alone.
 */
export class LambdaLogRetentionConstruct extends Construct {
  constructor(scope: Construct, id: string, props: LambdaLogRetentionConstructProps) {
    super(scope, id);

    const stack = cdk.Stack.of(this);
    const acronymLower = props.acronym.toLowerCase();
    // Function names in this deployment start with one of these: explicit
    // names use the lowercase acronym, CDK-generated names start with the
    // stack name, and a few regional hub functions use the PascalCase name.
    const functionNamePrefixes = [...new Set([`${acronymLower}-`, `${props.acronym}-`, `${props.pascalCaseName}-`])];

    const handler = new lambda.Function(this, 'Function', {
      functionName: `${acronymLower}-lambda-log-retention`,
      description: 'Sets a retention period on this deployment\'s Lambda log groups',
      runtime: lambda.Runtime.NODEJS_24_X,
      handler: 'index.handler',
      code: lambda.Code.fromAsset(path.join(__dirname, '../../lambda/lambda-log-retention')),
      timeout: cdk.Duration.minutes(10),
      memorySize: 256,
      reservedConcurrentExecutions: 2,
      environmentEncryption: props.dataEncryptionKey,
      environment: {
        RETENTION_DAYS: String(props.retentionDays),
        MANAGED_BY: props.pascalCaseName,
        FUNCTION_NAME_PREFIXES: functionNamePrefixes.join(','),
        REGIONAL_HUBS_TABLE_NAME: props.regionalHubsTable.tableName,
      },
      // New log groups, so CDK can manage them directly.
      logGroup: new logs.LogGroup(this, 'FunctionLogGroup', {
        retention: props.retentionDays,
        removalPolicy: cdk.RemovalPolicy.DESTROY,
      }),
    });

    props.regionalHubsTable.grantReadData(handler);

    // ListFunctions doesn't support resource-level permissions.
    handler.addToRolePolicy(new iam.PolicyStatement({
      actions: ['lambda:ListFunctions'],
      resources: ['*'],
    }));
    handler.addToRolePolicy(new iam.PolicyStatement({
      actions: ['lambda:ListTags'],
      resources: functionNamePrefixes.map(prefix => `arn:${stack.partition}:lambda:*:${stack.account}:function:${prefix}*`),
    }));
    handler.addToRolePolicy(new iam.PolicyStatement({
      actions: ['logs:DescribeLogGroups'],
      resources: [`arn:${stack.partition}:logs:*:${stack.account}:log-group:*`],
    }));
    // Only log groups named after this deployment's functions can be changed.
    handler.addToRolePolicy(new iam.PolicyStatement({
      actions: ['logs:CreateLogGroup', 'logs:PutRetentionPolicy'],
      resources: functionNamePrefixes.map(
        prefix => `arn:${stack.partition}:logs:*:${stack.account}:log-group:/aws/lambda/${prefix}*`
      ),
    }));

    const provider = new cr.Provider(this, 'Provider', {
      onEventHandler: handler,
      logGroup: new logs.LogGroup(this, 'ProviderLogGroup', {
        retention: props.retentionDays,
        removalPolicy: cdk.RemovalPolicy.DESTROY,
      }),
    });

    new cdk.CustomResource(this, 'ApplyRetention', {
      serviceToken: provider.serviceToken,
      resourceType: 'Custom::LambdaLogRetention',
      properties: {
        RetentionDays: props.retentionDays,
        ManagedBy: props.pascalCaseName,
        FunctionNamePrefixes: functionNamePrefixes.join(','),
        // Changes when a function is added, removed, or renamed anywhere in
        // the app, so the custom resource runs again and covers it. Resolved
        // at synth, after every stack has been constructed.
        FunctionSetHash: cdk.Lazy.string({ produce: () => functionSetHash(cdk.App.of(this)!) }),
      },
    });

    // Regional hubs are created at runtime, not by CDK. Run again when one is
    // created, so its functions get the retention period without waiting for
    // the next deploy.
    new events.Rule(this, 'RegionalHubCreatedRule', {
      ruleName: `${acronymLower}-lambda-log-retention-regional-hub`,
      description: 'Sets Lambda log retention in a new regional hub',
      eventPattern: {
        source: ['aws.states'],
        detailType: ['Step Functions Execution Status Change'],
        detail: {
          stateMachineArn: [
            `arn:${stack.partition}:states:${stack.region}:${stack.account}:stateMachine:${acronymLower}-regional-hub-creation`,
          ],
          status: ['SUCCEEDED'],
        },
      },
      targets: [new targets.LambdaFunction(handler, { retryAttempts: 2 })],
    });
  }
}

// A hash of every Lambda function in the app: its construct path, and its
// name when that is known at synth.
function functionSetHash(app: Construct): string {
  const entries = app.node.findAll()
    .filter((node): node is cdk.CfnResource =>
      cdk.CfnResource.isCfnResource(node) && node.cfnResourceType === 'AWS::Lambda::Function')
    .map(node => {
      const name = node instanceof lambda.CfnFunction ? node.functionName : undefined;
      return `${node.node.path}=${name && !cdk.Token.isUnresolved(name) ? name : ''}`;
    })
    .sort();
  return crypto.createHash('sha256').update(entries.join('\n')).digest('hex');
}
