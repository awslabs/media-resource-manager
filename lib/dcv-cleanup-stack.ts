// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import * as cdk from 'aws-cdk-lib';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as events from 'aws-cdk-lib/aws-events';
import * as targets from 'aws-cdk-lib/aws-events-targets';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as kms from 'aws-cdk-lib/aws-kms';
import * as path from 'path';
import { Construct } from 'constructs';

interface DCVCleanupStackProps extends cdk.StackProps {
  productName: string;
  pascalCaseName: string;
  acronym: string;
  workstationTable: dynamodb.Table;
  vpc: ec2.IVpc;
  workstationSecurityGroup: ec2.SecurityGroup;
  dataEncryptionKey?: kms.IKey;
}

export class DCVCleanupStack extends cdk.Stack {
  public readonly dcvCleanupFunction: lambda.Function;
  public readonly sessionCleanupFunction: lambda.Function;
  public readonly manualCleanupFunction: lambda.Function;

  constructor(scope: Construct, id: string, props: DCVCleanupStackProps) {
    super(scope, id, {
      ...props,
      description: "Automated cleanup processes for DCV sessions and orphaned resources"
    });

    // Lambda function to clean up DCV servers when instances are terminated
    this.dcvCleanupFunction = new lambda.Function(this, 'DCVCleanupFunction', {
      functionName: `${props.acronym.toLowerCase()}-dcv-cleanup`,
      runtime: lambda.Runtime.PYTHON_3_12,
      handler: 'index.lambda_handler',
      code: lambda.Code.fromAsset('lambda/dcv-cleanup'),
      vpc: props.vpc,
      vpcSubnets: {
        subnets: props.vpc.privateSubnets,
      },
      securityGroups: [props.workstationSecurityGroup],
      timeout: cdk.Duration.minutes(5),
      reservedConcurrentExecutions: 5,
      description: 'Cleans up DCV Session Manager servers when EC2 instances are terminated',
      environmentEncryption: props.dataEncryptionKey,
      environment: {
        PASCAL_CASE_NAME: props.pascalCaseName,
        WORKSTATION_TABLE_NAME: props.workstationTable.tableName,
      },
    });

    // Lambda function to clean up DCV sessions when instances are stopped/terminated
    this.sessionCleanupFunction = new lambda.Function(this, 'DCVSessionCleanupFunction', {
      functionName: `${props.acronym.toLowerCase()}-dcv-session-cleanup`,
      runtime: lambda.Runtime.PYTHON_3_12,
      handler: 'index.lambda_handler',
      code: lambda.Code.fromAsset('lambda/dcv-session-cleanup'),
      vpc: props.vpc,
      vpcSubnets: {
        subnets: props.vpc.privateSubnets,
      },
      securityGroups: [props.workstationSecurityGroup],
      timeout: cdk.Duration.minutes(3),
      reservedConcurrentExecutions: 15,
      description: 'Cleans up DCV sessions when EC2 instances are stopped or terminated',
      environmentEncryption: props.dataEncryptionKey,
      environment: {
        PASCAL_CASE_NAME: props.pascalCaseName,
        WORKSTATION_TABLE_NAME: props.workstationTable.tableName,
        ACRONYM: props.acronym,
      },
    });

    // Grant permissions to both cleanup functions
    const cleanupPermissions = new iam.PolicyStatement({
      effect: iam.Effect.ALLOW,
      actions: [
        'ssm:GetParameter',
        'ec2:DescribeInstances'
      ],
      resources: ['*'],
    });

    this.dcvCleanupFunction.addToRolePolicy(cleanupPermissions);
    this.sessionCleanupFunction.addToRolePolicy(cleanupPermissions);

    // Grant permission to invoke regional DCV session cleanup Lambda for satellite regions
    this.sessionCleanupFunction.addToRolePolicy(new iam.PolicyStatement({
      effect: iam.Effect.ALLOW,
      actions: ['lambda:InvokeFunction'],
      resources: [`arn:aws:lambda:*:${this.account}:function:${props.acronym.toLowerCase()}-regional-dcv-session-cleanup`],
    }));

    // Grant DynamoDB permissions
    props.workstationTable.grantWriteData(this.dcvCleanupFunction);
    props.workstationTable.grantWriteData(this.sessionCleanupFunction);
    // Also grant read access to look up workstation region
    props.workstationTable.grantReadData(this.sessionCleanupFunction);

    // Grant KMS permissions if tables use customer-managed encryption
    if (props.dataEncryptionKey) {
      props.dataEncryptionKey.grantEncryptDecrypt(this.dcvCleanupFunction);
      props.dataEncryptionKey.grantEncryptDecrypt(this.sessionCleanupFunction);
    }

    // EventBridge rule for session cleanup on stop/terminate
    const sessionCleanupRule = new events.Rule(this, 'SessionCleanupRule', {
      ruleName: `${props.acronym.toLowerCase()}-dcv-session-cleanup`,
      description: 'Triggers DCV session cleanup when EC2 instances are stopped or terminated',
      eventPattern: {
        source: ['aws.ec2'],
        detailType: ['EC2 Instance State-change Notification'],
        detail: {
          state: ['stopped', 'terminated']
        }
      }
    });

    // EventBridge rule for server cleanup on terminate only
    const serverCleanupRule = new events.Rule(this, 'ServerCleanupRule', {
      ruleName: `${props.acronym.toLowerCase()}-dcv-server-cleanup`,
      description: 'Triggers DCV server cleanup when EC2 instances are terminated',
      eventPattern: {
        source: ['aws.ec2'],
        detailType: ['EC2 Instance State-change Notification'],
        detail: {
          state: ['terminated']
        }
      }
    });

    // Add Lambda functions as targets
    sessionCleanupRule.addTarget(new targets.LambdaFunction(this.sessionCleanupFunction, {
      retryAttempts: 2,
    }));

    serverCleanupRule.addTarget(new targets.LambdaFunction(this.dcvCleanupFunction, {
      retryAttempts: 2,
    }));

    // Create a manual cleanup function that can be called via API
    this.manualCleanupFunction = new lambda.Function(this, 'ManualDCVCleanupFunction', {
      functionName: `${props.acronym.toLowerCase()}-dcv-manual-cleanup`,
      runtime: lambda.Runtime.PYTHON_3_12,
      handler: 'index.lambda_handler',
      reservedConcurrentExecutions: 5,
      environmentEncryption: props.dataEncryptionKey,
      environment: {
        PASCAL_CASE_NAME: props.pascalCaseName,
      },
      code: lambda.Code.fromAsset(path.join(__dirname, '../lambda/dcv-manual-cleanup')),
      vpc: props.vpc,
      vpcSubnets: {
        subnets: props.vpc.privateSubnets,
      },
      securityGroups: [props.workstationSecurityGroup],
      timeout: cdk.Duration.minutes(10),
      description: 'Manual cleanup function for stale DCV servers',
    });

    // Grant permissions to manual cleanup function
    this.manualCleanupFunction.addToRolePolicy(cleanupPermissions);

    // ============================================
    // BROKER HEALTH CHECK (Proactive)
    // ============================================

    // Lambda that probes the Session Manager broker health endpoint on a schedule.
    // If the broker is unresponsive, it restarts the service via SSM and refreshes
    // the DCV session manager Lambda ENIs to clear stale TCP connections.
    const brokerHealthCheckFunction = new lambda.Function(this, 'BrokerHealthCheckFunction', {
      functionName: `${props.acronym.toLowerCase()}-dcv-broker-health-check`,
      runtime: lambda.Runtime.PYTHON_3_12,
      handler: 'index.lambda_handler',
      code: lambda.Code.fromAsset(path.join(__dirname, '../lambda/dcv-broker-health-check')),
      vpc: props.vpc,
      vpcSubnets: {
        subnets: props.vpc.privateSubnets,
      },
      securityGroups: [props.workstationSecurityGroup],
      timeout: cdk.Duration.minutes(3),
      reservedConcurrentExecutions: 1,
      description: 'Proactive health check for DCV Session Manager broker',
      environmentEncryption: props.dataEncryptionKey,
      environment: {
        PASCAL_CASE_NAME: props.pascalCaseName,
        SESSION_MANAGER_LAMBDA_NAME: `${props.acronym.toLowerCase()}-dcv-session-manager`,
        HEALTH_CHECK_TIMEOUT_SECONDS: '10',
        MAX_WAIT_AFTER_RESTART_SECONDS: '60',
      },
    });

    // Grant permissions to health check function
    brokerHealthCheckFunction.addToRolePolicy(new iam.PolicyStatement({
      effect: iam.Effect.ALLOW,
      actions: ['ssm:GetParameter'],
      resources: [`arn:aws:ssm:${this.region}:${this.account}:parameter/${props.pascalCaseName}/DCV/*`],
    }));

    // Permission to find the Session Manager ASG and instance
    brokerHealthCheckFunction.addToRolePolicy(new iam.PolicyStatement({
      effect: iam.Effect.ALLOW,
      actions: ['autoscaling:DescribeAutoScalingGroups'],
      resources: ['*'],
    }));

    // Permission to restart the broker via SSM
    brokerHealthCheckFunction.addToRolePolicy(new iam.PolicyStatement({
      effect: iam.Effect.ALLOW,
      actions: ['ssm:SendCommand'],
      resources: [
        `arn:aws:ssm:${this.region}::document/AWS-RunShellScript`,
        `arn:aws:ec2:${this.region}:${this.account}:instance/*`,
      ],
    }));

    // Permission to refresh the DCV session manager Lambda ENIs
    brokerHealthCheckFunction.addToRolePolicy(new iam.PolicyStatement({
      effect: iam.Effect.ALLOW,
      actions: ['lambda:UpdateFunctionConfiguration'],
      resources: [`arn:aws:lambda:${this.region}:${this.account}:function:${props.acronym.toLowerCase()}-dcv-session-manager`],
    }));

    if (props.dataEncryptionKey) {
      props.dataEncryptionKey.grantDecrypt(brokerHealthCheckFunction);
    }

    // Run health check every 5 minutes
    const brokerHealthCheckRule = new events.Rule(this, 'BrokerHealthCheckRule', {
      ruleName: `${props.acronym.toLowerCase()}-dcv-broker-health-check`,
      description: 'Proactive health check for DCV Session Manager broker (every 5 minutes)',
      schedule: events.Schedule.rate(cdk.Duration.minutes(5)),
    });

    brokerHealthCheckRule.addTarget(new targets.LambdaFunction(brokerHealthCheckFunction, {
      retryAttempts: 0, // Don't retry — if it fails, the next scheduled run will catch it
    }));

    new cdk.CfnOutput(this, 'BrokerHealthCheckFunctionArn', {
      value: brokerHealthCheckFunction.functionArn,
      description: 'ARN of the DCV broker health check function',
    });

    new cdk.CfnOutput(this, 'BrokerHealthCheckRuleArn', {
      value: brokerHealthCheckRule.ruleArn,
      description: 'ARN of the broker health check EventBridge rule',
    });

    // Outputs
    new cdk.CfnOutput(this, 'DCVCleanupFunctionArn', {
      value: this.dcvCleanupFunction.functionArn,
      description: 'ARN of the DCV cleanup function',
    });

    new cdk.CfnOutput(this, 'SessionCleanupFunctionArn', {
      value: this.sessionCleanupFunction.functionArn,
      description: 'ARN of the DCV session cleanup function',
    });

    new cdk.CfnOutput(this, 'ManualCleanupFunctionArn', {
      value: this.manualCleanupFunction.functionArn,
      description: 'ARN of the manual DCV cleanup function',
    });

    new cdk.CfnOutput(this, 'SessionCleanupRuleArn', {
      value: sessionCleanupRule.ruleArn,
      description: 'ARN of the session cleanup EventBridge rule',
    });

    new cdk.CfnOutput(this, 'ServerCleanupRuleArn', {
      value: serverCleanupRule.ruleArn,
      description: 'ARN of the server cleanup EventBridge rule',
    });
  }
}
