// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import * as path from 'path';

import * as cdk from 'aws-cdk-lib';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as cr from 'aws-cdk-lib/custom-resources';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as kms from 'aws-cdk-lib/aws-kms';
import { Construct } from 'constructs';

interface CleanupConstructProps {
  securityGroupId: string;
  workstationTableName: string;
  acronym: string;
  pascalCaseName: string;
  dataEncryptionKey?: kms.IKey;
}

export class CleanupConstruct extends Construct {
  constructor(scope: Construct, id: string, props: CleanupConstructProps) {
    super(scope, id);

    const cleanupFunction = new lambda.Function(this, 'CleanupFunction', {
      functionName: `${props.acronym.toLowerCase()}-stack-cleanup`,
      runtime: lambda.Runtime.NODEJS_22_X,
      handler: 'index.handler',
      timeout: cdk.Duration.minutes(15),
      logGroup: new logs.LogGroup(this, 'CleanupFunctionLogGroup', {
        retention: logs.RetentionDays.ONE_MONTH,
        removalPolicy: cdk.RemovalPolicy.RETAIN,
      }),
      code: lambda.Code.fromAsset(path.join(__dirname, '../../lambda/stack-cleanup')),
    });

    cleanupFunction.addToRolePolicy(new iam.PolicyStatement({
      effect: iam.Effect.ALLOW,
      actions: [
        'ec2:DescribeInstances',
        'ec2:TerminateInstances',
        'ec2:DescribeNetworkInterfaces',
        'ec2:DeleteNetworkInterface',
        'dynamodb:Scan',
        'ssm:GetParametersByPath',
        'ssm:DeleteParameters'
      ],
      resources: ['*'],
    }));

    // Grant KMS permissions if tables use customer-managed encryption
    if (props.dataEncryptionKey) {
      props.dataEncryptionKey.grantDecrypt(cleanupFunction);
    }

    // Custom resource that triggers cleanup on stack deletion
    const customResourceProvider = new cr.Provider(this, 'CleanupProvider', {
      onEventHandler: cleanupFunction,
    });

    new cdk.CustomResource(this, 'CleanupResource', {
      serviceToken: customResourceProvider.serviceToken,
      properties: {
        SecurityGroupId: props.securityGroupId,
        WorkstationTableName: props.workstationTableName,
        SsmParameterPrefix: `/${props.pascalCaseName}/DCV`
      }
    });
  }
}
