// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import * as cdk from 'aws-cdk-lib';
import * as kms from 'aws-cdk-lib/aws-kms';
import * as sqs from 'aws-cdk-lib/aws-sqs';
import * as logs from 'aws-cdk-lib/aws-logs';
import { Construct } from 'constructs';

export interface SecurityConstructProps {
  pascalCaseName: string;
}

/**
 * Security construct that provides shared KMS keys and DLQ for Lambda functions
 * to satisfy Checkov security requirements:
 * - CKV_AWS_119: DynamoDB KMS encryption
 * - CKV_AWS_149: Secrets Manager KMS encryption
 * - CKV_AWS_116: Lambda DLQ
 * - CKV_AWS_158: CloudWatch Logs KMS encryption
 */
export class SecurityConstruct extends Construct {
  public readonly dataEncryptionKey: kms.Key;
  public readonly lambdaDlq: sqs.Queue;
  public readonly logsEncryptionKey: kms.Key;

  constructor(scope: Construct, id: string, props: SecurityConstructProps) {
    super(scope, id);

    // KMS key for data encryption (DynamoDB, Secrets Manager, SNS, etc.)
    this.dataEncryptionKey = new kms.Key(this, 'DataEncryptionKey', {
      alias: `${props.pascalCaseName.toLowerCase()}-data-key`,
      description: `KMS key for ${props.pascalCaseName} data encryption`,
      enableKeyRotation: true,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
      pendingWindow: cdk.Duration.days(7),
    });

    // KMS key for CloudWatch Logs encryption
    this.logsEncryptionKey = new kms.Key(this, 'LogsEncryptionKey', {
      alias: `${props.pascalCaseName.toLowerCase()}-logs-key`,
      description: `KMS key for ${props.pascalCaseName} CloudWatch Logs encryption`,
      enableKeyRotation: true,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
      pendingWindow: cdk.Duration.days(7),
    });

    // Allow CloudWatch Logs to use the key
    this.logsEncryptionKey.addToResourcePolicy(
      new cdk.aws_iam.PolicyStatement({
        principals: [
          new cdk.aws_iam.ServicePrincipal(`logs.${cdk.Stack.of(this).region}.amazonaws.com`),
        ],
        actions: [
          'kms:Encrypt*',
          'kms:Decrypt*',
          'kms:ReEncrypt*',
          'kms:GenerateDataKey*',
          'kms:Describe*',
        ],
        resources: ['*'],
        conditions: {
          ArnLike: {
            'kms:EncryptionContext:aws:logs:arn': `arn:aws:logs:${cdk.Stack.of(this).region}:${cdk.Stack.of(this).account}:*`,
          },
        },
      })
    );

    // Allow FSx service-linked role to use the data encryption key
    // Required for FSx Windows with self-managed AD to read AD credentials from Secrets Manager
    // Use AnyPrincipal with condition to avoid requiring the role to exist at deploy time
    // The service-linked role is created automatically when FSx is first used
    this.dataEncryptionKey.addToResourcePolicy(
      new cdk.aws_iam.PolicyStatement({
        sid: 'AllowFSxServiceLinkedRole',
        principals: [
          new cdk.aws_iam.AnyPrincipal(),
        ],
        actions: [
          'kms:Decrypt',
          'kms:DescribeKey',
          'kms:GenerateDataKey*',
        ],
        resources: ['*'],
        conditions: {
          ArnLike: {
            'aws:PrincipalArn': `arn:aws:iam::${cdk.Stack.of(this).account}:role/aws-service-role/fsx.amazonaws.com/AWSServiceRoleForAmazonFSx`,
          },
        },
      })
    );

    // Allow CloudFormation to decrypt secrets via Secrets Manager
    // Required for FSx Windows CloudFormation templates that use {{resolve:secretsmanager:...}} dynamic references
    this.dataEncryptionKey.addToResourcePolicy(
      new cdk.aws_iam.PolicyStatement({
        sid: 'AllowCloudFormationSecretsManagerAccess',
        principals: [
          new cdk.aws_iam.ServicePrincipal('cloudformation.amazonaws.com'),
        ],
        actions: [
          'kms:Decrypt',
          'kms:DescribeKey',
        ],
        resources: ['*'],
        conditions: {
          StringEquals: {
            'kms:ViaService': `secretsmanager.${cdk.Stack.of(this).region}.amazonaws.com`,
          },
        },
      })
    );

    // Shared Dead Letter Queue for Lambda functions (CKV_AWS_116)
    this.lambdaDlq = new sqs.Queue(this, 'LambdaDLQ', {
      queueName: `${props.pascalCaseName}-lambda-dlq`,
      encryption: sqs.QueueEncryption.KMS,
      encryptionMasterKey: this.dataEncryptionKey,
      retentionPeriod: cdk.Duration.days(14),
    });

    // Outputs
    new cdk.CfnOutput(this, 'DataEncryptionKeyArn', {
      value: this.dataEncryptionKey.keyArn,
      description: 'KMS Key ARN for data encryption',
      exportName: `${props.pascalCaseName}-DataEncryptionKeyArn`,
    });

    new cdk.CfnOutput(this, 'LambdaDlqArn', {
      value: this.lambdaDlq.queueArn,
      description: 'Lambda Dead Letter Queue ARN',
      exportName: `${props.pascalCaseName}-LambdaDlqArn`,
    });
  }
}
