// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import * as iam from 'aws-cdk-lib/aws-iam';

/**
 * Lets a workstation creation Lambda pass a regional hub's workstation role
 * to EC2, so it can launch workstations in that hub's Region.
 *
 * Hubs created before IAM names had a Region suffix name the role
 * `<ProductName>-Regional-Workstation-Role`. Newer hubs use
 * `<ProductName>-Regional-Workstation-Role-<regioncode>`, or
 * `<Acronym>-Regional-Workstation-Role-<regioncode>` when the full name would
 * pass 64 characters (see buildIamName in lambda/generate-regional-hub-template).
 */
export function regionalWorkstationPassRoleStatement(account: string, pascalCaseName: string, acronym: string): iam.PolicyStatement {
  return new iam.PolicyStatement({
    effect: iam.Effect.ALLOW,
    actions: ['iam:PassRole'],
    resources: [
      `arn:aws:iam::${account}:role/${pascalCaseName}-Regional-Workstation-Role`,
      `arn:aws:iam::${account}:role/${pascalCaseName}-Regional-Workstation-Role-*`,
      `arn:aws:iam::${account}:role/${acronym}-Regional-Workstation-Role-*`,
    ],
    conditions: { StringEquals: { 'iam:PassedToService': 'ec2.amazonaws.com' } },
  });
}
