// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import * as cdk from 'aws-cdk-lib';
import * as events from 'aws-cdk-lib/aws-events';
import * as targets from 'aws-cdk-lib/aws-events-targets';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as kms from 'aws-cdk-lib/aws-kms';
import * as path from 'path';
import { Construct } from 'constructs';

interface DcvStatusSyncStackProps extends cdk.StackProps {
  productName: string;
  pascalCaseName: string;
  acronym: string;
  workstationTable: dynamodb.Table;
  vpc: ec2.IVpc;
  dataEncryptionKey?: kms.IKey;
}

export class DcvStatusSyncStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props: DcvStatusSyncStackProps) {
    super(scope, id, {
      ...props,
      description: "DCV status monitoring and synchronization between sessions and workstation states"
    });

    // Lambda function to sync DCV connection status
    const statusSyncFunction = new lambda.Function(this, 'DcvStatusSyncFunction', {
      functionName: `${props.acronym.toLowerCase()}-dcv-status-sync`,
      runtime: lambda.Runtime.PYTHON_3_12,
      handler: 'index.lambda_handler',
      reservedConcurrentExecutions: 5,
      environmentEncryption: props.dataEncryptionKey,
      environment: {
        PASCAL_CASE_NAME: props.pascalCaseName,
        WORKSTATION_TABLE_NAME: props.workstationTable.tableName,
      },
      code: lambda.Code.fromAsset(path.join(__dirname, '../lambda/dcv-status-sync')),
      timeout: cdk.Duration.minutes(5),
      vpc: props.vpc,
      vpcSubnets: {
        subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS,
      },
    });

    // Grant DynamoDB permissions
    props.workstationTable.grantWriteData(statusSyncFunction);

    // Grant KMS permissions if tables use customer-managed encryption
    if (props.dataEncryptionKey) {
      props.dataEncryptionKey.grantEncryptDecrypt(statusSyncFunction);
    }

    // Grant SSM permissions
    statusSyncFunction.addToRolePolicy(new iam.PolicyStatement({
      effect: iam.Effect.ALLOW,
      actions: [
        'ssm:GetParameter',
      ],
      resources: [
        `arn:aws:ssm:${this.region}:${this.account}:parameter/${props.pascalCaseName}/DCV/SessionManager/*`,
      ],
    }));

    // Grant EC2 permissions to find instances by IP
    statusSyncFunction.addToRolePolicy(new iam.PolicyStatement({
      effect: iam.Effect.ALLOW,
      actions: [
        'ec2:DescribeInstances',
      ],
      resources: ['*'],
    }));

    // EventBridge rule to run every 5 minutes
    const statusSyncRule = new events.Rule(this, 'DcvStatusSyncRule', {
      ruleName: `${props.acronym.toLowerCase()}-dcv-status-sync`,
      schedule: events.Schedule.rate(cdk.Duration.minutes(5)),
      description: 'Sync DCV connection status every 5 minutes',
    });

    // Add Lambda as target
    statusSyncRule.addTarget(new targets.LambdaFunction(statusSyncFunction));

    // Outputs
    new cdk.CfnOutput(this, 'DcvStatusSyncFunctionArn', {
      value: statusSyncFunction.functionArn,
      description: 'DCV Status Sync Function ARN',
    });
  }
}
