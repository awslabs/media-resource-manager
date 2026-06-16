// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { NagSuppressions } from 'cdk-nag';
import { Stack } from 'aws-cdk-lib';

export class NagSuppressionHelper {
  static addCommonSuppressions(stack: Stack) {
    // Common suppressions for AWS managed policies
    NagSuppressions.addStackSuppressions(stack, [
      {
        id: 'AwsSolutions-IAM4',
        reason: 'AWS managed policies are acceptable for this workstation management use case',
      },
      {
        id: 'AwsSolutions-IAM5',
        reason: 'Wildcard permissions needed for dynamic resource management in workstation context',
      },
      {
        id: 'AwsSolutions-L1',
        reason: 'Lambda runtime versions will be updated in future iterations',
      },
    ]);
  }

  static addLambdaSuppressions(stack: Stack) {
    NagSuppressions.addStackSuppressions(stack, [
      {
        id: 'AwsSolutions-L1',
        reason: 'Lambda runtime versions are current and will be updated regularly',
      },
      {
        id: 'AwsSolutions-L2',
        reason: 'Lambda reserved concurrency not required for workstation management functions',
      },
    ]);
  }

  static addS3Suppressions(stack: Stack) {
    NagSuppressions.addStackSuppressions(stack, [
      {
        id: 'AwsSolutions-S1',
        reason: 'S3 access logging will be enabled in production environment',
      },
      {
        id: 'AwsSolutions-S2',
        reason: 'S3 bucket public read access is intentional for static website hosting',
      },
      {
        id: 'AwsSolutions-S10',
        reason: 'S3 bucket SSL-only access will be enforced in production',
      },
    ]);
  }

  static addCloudFrontSuppressions(stack: Stack) {
    NagSuppressions.addStackSuppressions(stack, [
      {
        id: 'AwsSolutions-CFR1',
        reason: 'CloudFront geo restrictions not required for internal workstation access',
      },
      {
        id: 'AwsSolutions-CFR2',
        reason: 'WAF not required for internal workstation management interface',
      },
      {
        id: 'AwsSolutions-CFR3',
        reason: 'CloudFront access logging will be enabled in production',
      },
      {
        id: 'AwsSolutions-CFR4',
        reason: 'Custom SSL certificate will be configured in production',
      },
    ]);
  }

  static addVPCSuppressions(stack: Stack) {
    NagSuppressions.addStackSuppressions(stack, [
      {
        id: 'AwsSolutions-VPC7',
        reason: 'VPC Flow Logs will be enabled in production environment',
      },
    ]);
  }

  static addEC2Suppressions(stack: Stack) {
    NagSuppressions.addStackSuppressions(stack, [
      {
        id: 'AwsSolutions-EC23',
        reason: 'Security group allows necessary ports for DCV workstation access',
      },
      {
        id: 'AwsSolutions-EC29',
        reason: 'Termination protection not required for development workstations',
      },
    ]);
  }
}
